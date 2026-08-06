import type {
  ChartBridge,
  ChartBridgeId,
  ChartChangeReason,
  LastBar,
  PaneRect,
  ProbeCheckResult,
  ProbeResult,
} from '../ChartBridge';
import type { InternalApiHostConfig } from './hostConfigs';
import { getLogger } from '../../utils/logger';

/**
 * The ONE bridge implementation shared by tradingview.com and Kotak Neo
 * (IMPLEMENTATION_PLAN.md §4.1/§4.2/§5.2) — confirmed to expose the same
 * internal, undocumented method chain, differing only in global name
 * (hostConfigs.ts) and frame nesting (handled by the manifest, not here).
 *
 * ⚠️ Every method name below is undocumented and minified per §4.1 ("the
 * widget class came back as `Hp`"). TradingView/Kotak can rename any of it
 * in any deploy — that's the accepted risk this whole class exists to
 * contain (§8.1). Every access is wrapped so a fault is a caught, logged,
 * `null`-returning event, never a throw into the host page (§5.4/§7.4).
 *
 * ⚠️ Build-environment caveat: the exact call chain here is transcribed
 * from the plan's §4.1/§4.2 probe output (captured live via Claude in
 * Chrome against real tradingview.com and Kotak Neo pages in a prior
 * session). This implementation could not be re-verified against a live
 * page from this headless build session — there is no browser/display
 * here to load the unpacked extension and hit the real sites. Treat this
 * as faithfully-transcribed-but-unexecuted until it's loaded in an actual
 * Chrome profile against a live chart (see P8's soak test).
 */

const log = getLogger('bridge:tv-internal-api');

type Unknown = any;

function getGlobal(candidateGlobals: readonly string[]): Unknown {
  const win = window as unknown as Record<string, Unknown>;
  for (const name of candidateGlobals) {
    if (win[name] != null) return win[name];
  }
  return null;
}

/** Builds a ProbeCheckResult, omitting `detail` entirely rather than setting it to `undefined`
 * (required under `exactOptionalPropertyTypes`). */
function mkCheck(name: string, passed: boolean, detail?: string): ProbeCheckResult {
  return detail === undefined ? { name, passed } : { name, passed, detail };
}

/** Runs `fn` and turns any throw into `null` — the bridge NEVER throws into the host page. */
function guarded<T>(fn: () => T): T | null {
  try {
    const result = fn();
    return result === undefined ? null : result;
  } catch (error) {
    log.debug('guarded call failed', { error: String(error) });
    return null;
  }
}

interface ResolvedHandles {
  readonly chart: Unknown;
  readonly paneWidget: Unknown;
  readonly priceScale: Unknown;
  readonly timeScale: Unknown;
  readonly mainSeries: Unknown;
}

export class TradingViewInternalApiBridge implements ChartBridge {
  readonly id: ChartBridgeId;
  private readonly config: InternalApiHostConfig;
  private readonly changeListeners = new Set<(reason: ChartChangeReason) => void>();
  private subscribedChart: Unknown = null;
  private readonly boundHandlers: Record<ChartChangeReason, () => void>;
  private resizeObserver: ResizeObserver | null = null;

  constructor(config: InternalApiHostConfig) {
    this.config = config;
    this.id = config.id;
    this.boundHandlers = {
      range: () => this.emit('range'),
      symbol: () => this.emit('symbol'),
      interval: () => this.emit('interval'),
      resize: () => this.emit('resize'),
    };
  }

  private emit(reason: ChartChangeReason): void {
    for (const cb of this.changeListeners) {
      guarded(() => cb(reason));
    }
  }

  isAvailable(): boolean {
    return this.resolve() !== null;
  }

  /**
   * Walks §4.1's verified chain:
   *   activeChart() -> chartWidget() -> paneWidgets()[0]
   *     -> state().defaultPriceScale()               (priceToY/yToPrice)
   *     -> model().model().timeScale()                (timeToX)
   *     -> model().model().mainSeries()                (lastBar)
   */
  private resolve(): ResolvedHandles | null {
    return guarded(() => {
      const api = getGlobal(this.config.candidateGlobals);
      if (api == null) return null;
      const chart = api.activeChart?.();
      if (chart == null) return null;
      const chartWidget = chart.chartWidget?.();
      if (chartWidget == null) return null;
      const paneWidgets = chartWidget.paneWidgets?.();
      const paneWidget = paneWidgets?.[0];
      if (paneWidget == null) return null;
      const priceScale = paneWidget.state?.()?.defaultPriceScale?.();
      const model = chartWidget.model?.()?.model?.();
      const timeScale = model?.timeScale?.();
      const mainSeries = model?.mainSeries?.();
      if (priceScale == null || timeScale == null || mainSeries == null) return null;
      return { chart, paneWidget, priceScale, timeScale, mainSeries };
    });
  }

  private resolvePaneRect(): DOMRect | null {
    const handles = this.resolve();
    if (handles == null) return null;
    return guarded(() => handles.paneWidget.canvasElement?.()?.getBoundingClientRect?.() ?? null);
  }

  paneRect(): PaneRect | null {
    const rect = this.resolvePaneRect();
    if (rect == null) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  }

  priceToY(price: number): number | null {
    if (!Number.isFinite(price)) return null;
    const handles = this.resolve();
    if (handles == null) return null;
    const rect = this.resolvePaneRect();
    const coord = guarded(() => handles.priceScale.priceToCoordinate?.(price));
    if (coord == null || !Number.isFinite(coord)) return null;
    if (rect == null) return null;
    const viewportY = rect.y + coord;
    // Off-screen (above/below the pane) -> null, never extrapolate (§R-P4a).
    if (viewportY < rect.y - 1 || viewportY > rect.y + rect.height + 1) return null;
    return viewportY;
  }

  yToPrice(y: number): number | null {
    if (!Number.isFinite(y)) return null;
    const handles = this.resolve();
    if (handles == null) return null;
    const rect = this.resolvePaneRect();
    if (rect == null) return null;
    const localY = y - rect.y;
    const price = guarded(() => handles.priceScale.coordinateToPrice?.(localY));
    if (price == null || !Number.isFinite(price)) return null;
    return price;
  }

  timeToX(time: number): number | null {
    if (!Number.isFinite(time)) return null;
    const handles = this.resolve();
    if (handles == null) return null;
    const rect = this.resolvePaneRect();
    if (rect == null) return null;

    const index = guarded(() => {
      const bars = handles.mainSeries.bars?.();
      if (bars == null) return null;
      const lastIndex = bars.lastIndex?.();
      if (typeof lastIndex !== 'number') return null;
      // Bounded backward scan from the last bar — sufficient for our use
      // (pills anchor at/near the live price, i.e. near the last bar).
      // Undocumented API, no direct time->index lookup is known to exist;
      // see the class-level caveat.
      const MAX_SCAN = 5000;
      for (let i = lastIndex; i >= Math.max(0, lastIndex - MAX_SCAN); i--) {
        const bar = bars.valueAt?.(i);
        if (Array.isArray(bar) && bar[0] === time) return i;
      }
      return null;
    });
    if (index == null) return null;

    const coord = guarded(() => handles.timeScale.indexToCoordinate?.(index));
    if (coord == null || !Number.isFinite(coord)) return null;
    const viewportX = rect.x + coord;
    if (viewportX < rect.x - 1 || viewportX > rect.x + rect.width + 1) return null;
    return viewportX;
  }

  lastBar(): LastBar | null {
    const handles = this.resolve();
    if (handles == null) return null;
    return guarded(() => {
      const bars = handles.mainSeries.bars?.();
      const lastIndex = bars?.lastIndex?.();
      if (typeof lastIndex !== 'number') return null;
      const bar = bars.valueAt?.(lastIndex);
      // Verified shape (§4.1): [time, open, high, low, close, volume]
      if (!Array.isArray(bar) || bar.length < 5) return null;
      const time = bar[0];
      const close = bar[4];
      if (typeof time !== 'number' || typeof close !== 'number') return null;
      return { time, close };
    });
  }

  symbol(): string | null {
    const handles = this.resolve();
    if (handles == null) return null;
    const raw = guarded(() => handles.chart.symbol?.());
    return typeof raw === 'string' ? raw : null;
  }

  /**
   * §5.4's capability probe, checks 1-4. Orchestration (surfacing this to
   * the popup/content script, the manual-mode fallback UI) is P2's
   * CapabilityProbe.ts — this method just runs the raw checks, since it's
   * the only place with direct access to the internals being tested.
   */
  probe(): ProbeResult {
    const checks: ProbeCheckResult[] = [];

    const handles = this.resolve();
    checks.push(
      mkCheck(
        'chain-resolves',
        handles !== null,
        handles === null ? 'activeChart()/chartWidget()/paneWidgets chain did not resolve' : undefined,
      ),
    );

    let overall: ProbeResult['overall'] = 'unavailable';

    if (handles !== null) {
      const bar = this.lastBar();
      const rect = this.resolvePaneRect();

      const yFromPrice = bar !== null ? this.priceToY(bar.close) : null;
      const priceToYInPane =
        yFromPrice !== null && rect !== null && yFromPrice >= rect.y - 1 && yFromPrice <= rect.y + rect.height + 1;
      checks.push(
        mkCheck(
          'priceToY-in-pane',
          priceToYInPane,
          !priceToYInPane ? `priceToY(lastClose)=${String(yFromPrice)} outside pane rect` : undefined,
        ),
      );

      let roundTripOk = false;
      if (yFromPrice !== null && bar !== null) {
        const backToPrice = this.yToPrice(yFromPrice);
        roundTripOk = backToPrice !== null && Math.abs(backToPrice - bar.close) < Math.max(bar.close * 0.001, 0.5);
      }
      checks.push(
        mkCheck(
          'round-trip-within-tolerance',
          roundTripOk,
          !roundTripOk ? 'yToPrice(priceToY(p)) did not round-trip within tolerance' : undefined,
        ),
      );

      const xFromTime = bar !== null ? this.timeToX(bar.time) : null;
      const timeToXInPane =
        xFromTime !== null && rect !== null && xFromTime >= rect.x - 1 && xFromTime <= rect.x + rect.width + 1;
      checks.push(
        mkCheck(
          'timeToX-in-pane',
          timeToXInPane,
          !timeToXInPane ? `timeToX(lastBar.time)=${String(xFromTime)} outside pane rect` : undefined,
        ),
      );

      const allCoordChecksPassed = priceToYInPane && roundTripOk && timeToXInPane;
      overall = allCoordChecksPassed ? 'full' : 'degraded';
    }

    return {
      bridgeId: this.id,
      timestampMs: Date.now(),
      checks,
      overall,
    };
  }

  onChange(cb: (reason: ChartChangeReason) => void): () => void {
    this.changeListeners.add(cb);
    this.ensureSubscribed();
    return () => {
      this.changeListeners.delete(cb);
      if (this.changeListeners.size === 0) {
        this.teardownSubscriptions();
      }
    };
  }

  private ensureSubscribed(): void {
    if (this.subscribedChart !== null) return;
    const handles = this.resolve();
    if (handles === null) return;
    const chart = handles.chart;
    guarded(() => chart.onVisibleRangeChanged?.()?.subscribe?.(null, this.boundHandlers.range));
    guarded(() => chart.onSymbolChanged?.()?.subscribe?.(null, this.boundHandlers.symbol));
    guarded(() => chart.onIntervalChanged?.()?.subscribe?.(null, this.boundHandlers.interval));
    guarded(() => chart.onDataLoaded?.()?.subscribe?.(null, this.boundHandlers.range));
    this.subscribedChart = chart;

    if (typeof ResizeObserver !== 'undefined') {
      const rect = this.resolvePaneRect();
      const canvas = guarded(() => handles.paneWidget.canvasElement?.());
      if (canvas instanceof Element) {
        this.resizeObserver = new ResizeObserver(() => this.boundHandlers.resize());
        this.resizeObserver.observe(canvas);
      }
      void rect;
    }
  }

  private teardownSubscriptions(): void {
    const chart = this.subscribedChart;
    if (chart !== null) {
      guarded(() => chart.onVisibleRangeChanged?.()?.unsubscribe?.(null, this.boundHandlers.range));
      guarded(() => chart.onSymbolChanged?.()?.unsubscribe?.(null, this.boundHandlers.symbol));
      guarded(() => chart.onIntervalChanged?.()?.unsubscribe?.(null, this.boundHandlers.interval));
      guarded(() => chart.onDataLoaded?.()?.unsubscribe?.(null, this.boundHandlers.range));
    }
    this.subscribedChart = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Full teardown — called on SPA nav / extension disable (§R-P1). */
  dispose(): void {
    this.changeListeners.clear();
    this.teardownSubscriptions();
  }
}
