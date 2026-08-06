/**
 * ISOLATED-world bootstrap (§P1/§6.0): ready-gate -> inject -> observe ->
 * teardown. Ties together the injection guard, the bridge client, chart
 * readiness, the Day-1 hardcoded suggestion, and SPA navigation handling.
 *
 * This is deliberately the ONE place that knows the full lifecycle. Every
 * piece it composes (BridgeClient, WidgetRoot, SpaNavigationObserver) is
 * independently unit-testable; this file is the wiring, kept thin on
 * purpose so lifecycle bugs have one place to look.
 */

import { createBridgeClient, type BridgeClient } from '../bridge/BridgeClient';
import { resolveHostConfigForLocation } from '../bridge/adapters/hostConfigs';
import { WidgetRoot } from '../widget/WidgetRoot';
import { buildDemoSuggestionConfig, DEMO_FALLBACK_SPOT, type DemoSuggestionConfig } from './demoSuggestion';
import { waitForChartReady } from './ChartReadyDetector';
import { SpaNavigationObserver } from './SpaNavigationObserver';
import { markInjected, shouldInject, clearInjectedFlag } from './InjectionGuard';
import { getLogger } from '../utils/logger';

const log = getLogger('content:bootstrap');

const LAST_BAR_GRACE_MS = 5000;
const LAST_BAR_POLL_MS = 250;

async function waitForFirstBar(bridge: BridgeClient, graceMs: number): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < graceMs) {
    const bar = bridge.lastBar();
    if (bar !== null) return bar.close;
    await new Promise((resolve) => setTimeout(resolve, LAST_BAR_POLL_MS));
  }
  return null;
}

function buildTradeHandler(widget: WidgetRoot, config: DemoSuggestionConfig): () => void {
  return () => {
    const message = `Would place: BUY ${config.strikeLabel}, entry ${config.entry}, SL ${config.sl}, TP ${config.tp}`;
    log.info(message);
    widget.showToast(message);
  };
}

export class Bootstrap {
  private bridge: BridgeClient | null = null;
  private widget: WidgetRoot | null = null;
  private spaObserver: SpaNavigationObserver | null = null;
  private disposed = false;
  private runToken = 0;

  async start(): Promise<void> {
    if (!shouldInject()) {
      log.debug('injection guard: already injected in this frame, skipping');
      return;
    }
    markInjected();

    this.spaObserver = new SpaNavigationObserver(() => {
      void this.handleNavigation();
    });
    this.spaObserver.start();

    await this.runOnce();
  }

  private async handleNavigation(): Promise<void> {
    log.info('re-bootstrapping after SPA navigation');
    this.teardownWidgetAndBridge();
    await this.runOnce();
  }

  private async runOnce(): Promise<void> {
    const token = ++this.runToken;
    const hostConfig = resolveHostConfigForLocation(window.location);
    if (hostConfig === null) {
      log.debug('not a recognized chart host/frame — nothing to mount here');
      return;
    }

    const bridge = createBridgeClient(hostConfig.id);
    this.bridge = bridge;

    const ready = await waitForChartReady(bridge);
    if (this.disposed || token !== this.runToken) return; // torn down or superseded mid-wait
    if (!ready) {
      // §5.4 degradation ladder: "Bridge entirely absent -> Widget does
      // not mount. Popup says why." Popup wiring lands with the P2/P7
      // popup work; for now this is loud in the console, which is the
      // channel we do have today (§7.2 — never silent).
      log.error('chart bridge never became available — widget will not mount (host page left untouched)', {
        hostId: hostConfig.id,
      });
      return;
    }

    const spot = (await waitForFirstBar(bridge, LAST_BAR_GRACE_MS)) ?? DEMO_FALLBACK_SPOT;
    if (this.disposed || token !== this.runToken) return;
    if (spot === DEMO_FALLBACK_SPOT) {
      log.warn('no live bar observed within grace window — using fallback demo spot', {
        fallback: DEMO_FALLBACK_SPOT,
      });
    }
    const suggestionConfig = buildDemoSuggestionConfig(spot);

    // The Trade handler needs a WidgetRoot instance (to call showToast on)
    // that doesn't exist until after construction — constructed once with
    // a no-op, then patched via updateSuggestion immediately below. This
    // two-step dance is local to Day-1's stub; P6's real onTrade (calling
    // our order API) won't need the widget instance itself and can be
    // built before construction like everything else in this object.
    const widget = new WidgetRoot({
      bridge,
      demoMode: true,
      suggestion: {
        symbolLabel: suggestionConfig.strikeLabel,
        subLabel: `Entry ${suggestionConfig.entry}`,
        livePrice: () => bridge.lastBar()?.close ?? null,
        tp: suggestionConfig.tp,
        sl: suggestionConfig.sl,
        tradeDisabled: false,
        staleReason: null,
        onTrade: () => {},
      },
    });
    this.widget = widget;
    widget.updateSuggestion({
      symbolLabel: suggestionConfig.strikeLabel,
      subLabel: `Entry ${suggestionConfig.entry}`,
      livePrice: () => bridge.lastBar()?.close ?? null,
      tp: suggestionConfig.tp,
      sl: suggestionConfig.sl,
      tradeDisabled: false,
      staleReason: null,
      onTrade: buildTradeHandler(widget, suggestionConfig),
    });

    await widget.mount();
  }

  private teardownWidgetAndBridge(): void {
    this.widget?.destroy();
    this.widget = null;
    this.bridge?.dispose();
    this.bridge = null;
  }

  /** Full teardown (§7.5/§R-P1) — everything released, injected flag cleared. */
  destroy(): void {
    this.disposed = true;
    this.spaObserver?.stop();
    this.spaObserver = null;
    this.teardownWidgetAndBridge();
    clearInjectedFlag();
  }
}
