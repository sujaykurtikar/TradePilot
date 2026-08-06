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
import type { InternalApiHostConfig } from '../bridge/adapters/hostConfigs';
import { CapabilityProbe, type DegradationState } from '../bridge/CapabilityProbe';
import { WidgetRoot, type WidgetSuggestionData } from '../widget/WidgetRoot';
import type { Offset } from '../widget/managers/DragManager';
import {
  buildDemoSuggestionConfig,
  DEMO_FALLBACK_SPOT,
  type DemoSuggestionConfig,
} from './demoSuggestion';
import { waitForChartReady } from './ChartReadyDetector';
import { SpaNavigationObserver } from './SpaNavigationObserver';
import { markInjected, shouldInject, clearInjectedFlag } from './InjectionGuard';
import { StorageManager } from '../core/storage/StorageManager';
import type { StorageSchema } from '../core/storage/schema';
import { isDataUpdateMessage } from '../core/messaging/guards';
import type { TabVisibilityMessage } from '../core/messaging/messages';
import type { MarketDataSnapshot } from '../core/api/types';
import { getLogger } from '../utils/logger';

const log = getLogger('content:bootstrap');

const LAST_BAR_GRACE_MS = 5000;
const LAST_BAR_POLL_MS = 250;
const OFFSET_PERSIST_DEBOUNCE_MS = 400;
/** §R-P5: "last success > 15s ago" -> stale. Matches DataPoller's own base poll interval (5s) with real margin. */
const FRESHNESS_WINDOW_MS = 15_000;

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

function isSnapshotFresh(snapshot: MarketDataSnapshot, nowMs: number): boolean {
  if (snapshot.chartContext?.isFresh === false) return false;
  if (snapshot.lastSuccessAtMs === null) return false;
  return nowMs - snapshot.lastSuccessAtMs <= FRESHNESS_WINDOW_MS;
}

function reportTabVisibility(): void {
  const message: TabVisibilityMessage = {
    type: 'tradepilot/tab-visibility',
    visible: document.visibilityState === 'visible',
  };
  chrome.runtime.sendMessage(message).catch((error: unknown) => {
    log.debug('tab-visibility report failed (non-fatal)', { error: String(error) });
  });
}

export class Bootstrap {
  private bridge: BridgeClient | null = null;
  private widget: WidgetRoot | null = null;
  private spaObserver: SpaNavigationObserver | null = null;
  private disposed = false;
  private runToken = 0;

  private readonly storage = new StorageManager();
  private storageUnsubscribe: (() => void) | null = null;
  private lastKnownEnabled = true;
  private offsetsWereEmpty = true;
  private pendingOffsets: Record<string, Offset> = {};
  private offsetPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPeriodicProbe: (() => void) | null = null;

  private hostConfig: InternalApiHostConfig | null = null;
  private latestSnapshot: MarketDataSnapshot | null = null;
  private readonly onRuntimeMessage = (message: unknown): void => {
    if (isDataUpdateMessage(message)) {
      this.applyMarketData(message.snapshot);
    }
  };
  private readonly onVisibilityChange = (): void => reportTabVisibility();

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

    // §P5: reports this tab's visibility so background's DataPoller only
    // polls when something can actually see the result.
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    reportTabVisibility();

    const state = await this.storage.load();
    this.lastKnownEnabled = state.enabled;
    this.offsetsWereEmpty = Object.keys(state.widgetOffsets).length === 0;
    this.storageUnsubscribe = this.storage.onChange((next) => this.handleStorageChange(next));

    if (!state.enabled) {
      log.info('TradePilot is disabled (popup toggle) — not mounting');
      return;
    }
    await this.runOnce();
  }

  /** Popup toggling "enabled" or "reset position" while this tab is already open — no reload needed. */
  private handleStorageChange(next: StorageSchema): void {
    if (next.enabled !== this.lastKnownEnabled) {
      this.lastKnownEnabled = next.enabled;
      if (next.enabled) {
        void this.runOnce();
      } else {
        this.teardownWidgetAndBridge();
      }
      return; // mounting fresh already applies current collapsed/offsets state
    }

    if (this.widget === null) return;
    this.widget.setCollapsedExternal(next.widgetCollapsed);

    const nowEmpty = Object.keys(next.widgetOffsets).length === 0;
    if (nowEmpty && !this.offsetsWereEmpty) {
      this.widget.resetOffsets();
    }
    this.offsetsWereEmpty = nowEmpty;
  }

  private async handleNavigation(): Promise<void> {
    log.info('re-bootstrapping after SPA navigation');
    this.teardownWidgetAndBridge();
    if (this.lastKnownEnabled) {
      await this.runOnce();
    }
  }

  private async runOnce(): Promise<void> {
    const token = ++this.runToken;
    const hostConfig = resolveHostConfigForLocation(window.location);
    if (hostConfig === null) {
      log.debug('not a recognized chart host/frame — nothing to mount here');
      return;
    }

    this.hostConfig = hostConfig;
    const bridge = createBridgeClient(hostConfig.id);
    this.bridge = bridge;

    const ready = await waitForChartReady(bridge);
    if (this.disposed || token !== this.runToken) return; // torn down or superseded mid-wait
    if (!ready) {
      // §5.4 degradation ladder: "Bridge entirely absent -> Widget does
      // not mount. Popup says why." Popup wiring lands with the P2/P7
      // popup work; for now this is loud in the console, which is the
      // channel we do have today (§7.2 — never silent).
      log.error(
        'chart bridge never became available — widget will not mount (host page left untouched)',
        {
          hostId: hostConfig.id,
        },
      );
      return;
    }

    // §5.4: the capability probe runs before anything depends on the
    // bridge, i.e. right here — before the widget mounts, not after.
    const probe = new CapabilityProbe(bridge);
    const initialState = await probe.runOnce();
    if (this.disposed || token !== this.runToken) return;
    if (initialState.mode === 'unavailable') {
      log.error('capability probe failed — widget will not mount (host page left untouched)', {
        hostId: hostConfig.id,
        reason: initialState.reason,
      });
      return;
    }
    if (initialState.mode === 'manual') {
      log.warn('capability probe degraded — mounting in manual mode', {
        reason: initialState.reason,
      });
    }

    const spot = (await waitForFirstBar(bridge, LAST_BAR_GRACE_MS)) ?? DEMO_FALLBACK_SPOT;
    if (this.disposed || token !== this.runToken) return;
    if (spot === DEMO_FALLBACK_SPOT) {
      log.warn('no live bar observed within grace window — using fallback demo spot', {
        fallback: DEMO_FALLBACK_SPOT,
      });
    }
    const suggestionConfig = buildDemoSuggestionConfig(spot);
    const persistedState = await this.storage.load();
    if (this.disposed || token !== this.runToken) return;

    // The Trade handler needs a WidgetRoot instance (to call showToast on)
    // that doesn't exist until after construction — constructed once with
    // a no-op, then patched via updateSuggestion immediately below. This
    // two-step dance is local to Day-1's stub; P6's real onTrade (calling
    // our order API) won't need the widget instance itself and can be
    // built before construction like everything else in this object.
    const widget = new WidgetRoot({
      bridge,
      demoMode: true,
      initialMode: initialState.mode,
      initialManualReason: initialState.reason,
      initialCollapsed: persistedState.widgetCollapsed,
      initialOffsets: persistedState.widgetOffsets,
      onCollapsedChange: (collapsed) => {
        void this.storage.patch({ widgetCollapsed: collapsed });
      },
      onOffsetChange: (id, offset) => this.persistOffsetDebounced(id, offset),
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

    // §8.1: re-probe periodically so a vendor deploy mid-session is
    // caught within the interval, not from a bad fill.
    this.stopPeriodicProbe = probe.startPeriodic((state) => this.handleProbeUpdate(state, token));

    // §P5: a data push may already have arrived while we were waiting on
    // chart-ready/probe (e.g. re-mounting after an SPA nav) — apply it
    // immediately rather than showing the Day-1 demo numbers again for a
    // few extra seconds until the next scheduled push.
    if (this.latestSnapshot !== null) {
      this.applyMarketData(this.latestSnapshot);
    }
  }

  private handleProbeUpdate(state: DegradationState, token: number): void {
    if (this.disposed || token !== this.runToken || this.widget === null) return;
    if (state.mode === 'unavailable') {
      log.error('capability probe lost the chart bridge mid-session — tearing the widget down', {
        reason: state.reason,
      });
      this.teardownWidgetAndBridge();
      return;
    }
    this.widget.setMode(state.mode, state.reason);
  }

  /**
   * §P5/§R-P5: applies a pushed MarketDataSnapshot, superseding the Day-1
   * hardcoded suggestion (§6.0's own framing: "P5 replaces the hardcoded
   * suggestion object... progressively real underneath"). This is a live
   * override the moment ANY push arrives — including a push that merely
   * confirms the API is unreachable — not something deferred until a
   * successful response specifically. That's a deliberate reliability
   * choice, not an accident: continuing to show the Day-1 demo numbers
   * once P5 is wired in would be showing fabricated values with no
   * "DEMO" framing left to justify it (§7.1 bans exactly that). The
   * correct honest behavior once this path exists is "real data, or a
   * visibly stale/disabled state" — never silently-stale fake numbers.
   */
  private applyMarketData(snapshot: MarketDataSnapshot): void {
    this.latestSnapshot = snapshot;
    const widget = this.widget;
    const bridge = this.bridge;
    const hostConfig = this.hostConfig;
    if (widget === null || bridge === null || hostConfig === null) return;

    // §R-P5 "unmapped symbol hides the widget rather than guessing."
    const chartSymbol = bridge.symbol();
    const mappedSymbol = chartSymbol !== null ? (hostConfig.symbolMap[chartSymbol] ?? null) : null;
    if (chartSymbol !== null && mappedSymbol === null) {
      log.warn('chart symbol has no entry in the symbol map — hiding widget', { chartSymbol });
      widget.setHidden(true);
      return;
    }
    widget.setHidden(false);

    const fresh = isSnapshotFresh(snapshot, Date.now());
    const suggestion = snapshot.suggestion;
    const hasEntry = suggestion !== null && suggestion.recommendedLtp !== null;

    let staleReason: string | null = null;
    if (!fresh) staleReason = snapshot.lastError ?? 'stale';
    else if (!hasEntry) staleReason = 'no suggestion';

    const optionSuffix = suggestion?.recommendedOptionType
      ? ` ${suggestion.recommendedOptionType}`
      : '';
    const symbolLabel =
      hasEntry && suggestion !== null
        ? `${suggestion.recommendedSymbol}${optionSuffix}`
        : (mappedSymbol ?? 'TradePilot');

    const suggestionData: WidgetSuggestionData = {
      symbolLabel,
      subLabel: hasEntry && suggestion !== null ? `LTP ${suggestion.recommendedLtp}` : null,
      livePrice: () => this.bridge?.lastBar()?.close ?? null,
      // §7.1 "no ?? 0, ever": missing/stale -> null, which LevelPill
      // already renders as hidden/dash rather than guessing a level.
      tp: fresh && hasEntry && suggestion !== null ? suggestion.tp : null,
      sl: fresh && hasEntry && suggestion !== null ? suggestion.sl : null,
      tradeDisabled: !fresh || !hasEntry,
      staleReason,
      onTrade: this.buildLiveTradeHandler(),
    };
    widget.updateSuggestion(suggestionData);
  }

  private buildLiveTradeHandler(): () => void {
    return () => {
      const widget = this.widget;
      const suggestion = this.latestSnapshot?.suggestion;
      if (widget === null) return;
      if (suggestion === null || suggestion === undefined || suggestion.recommendedLtp === null) {
        widget.showToast('No suggestion available to trade');
        return;
      }
      const optionSuffix = suggestion.recommendedOptionType
        ? ` ${suggestion.recommendedOptionType}`
        : '';
      const message = `Would place: ${suggestion.direction} ${suggestion.recommendedSymbol}${optionSuffix}, entry ${suggestion.recommendedLtp}, SL ${suggestion.sl ?? '—'}, TP ${suggestion.tp ?? '—'}`;
      log.info(message);
      widget.showToast(message);
    };
  }

  /** Coalesces rapid drag-move updates into one storage write, not one per pointermove. */
  private persistOffsetDebounced(id: string, offset: Offset): void {
    this.pendingOffsets[id] = offset;
    if (this.offsetPersistTimer !== null) clearTimeout(this.offsetPersistTimer);
    this.offsetPersistTimer = setTimeout(() => {
      const toWrite = this.pendingOffsets;
      this.pendingOffsets = {};
      this.offsetPersistTimer = null;
      this.storage
        .load()
        .then((current) =>
          this.storage.patch({ widgetOffsets: { ...current.widgetOffsets, ...toWrite } }),
        )
        .catch((error: unknown) =>
          log.warn('failed to persist widget offsets', { error: String(error) }),
        );
    }, OFFSET_PERSIST_DEBOUNCE_MS);
  }

  private teardownWidgetAndBridge(): void {
    this.stopPeriodicProbe?.();
    this.stopPeriodicProbe = null;
    this.widget?.destroy();
    this.widget = null;
    this.bridge?.dispose();
    this.bridge = null;
  }

  /** Full teardown (§7.5/§R-P1) — everything released, injected flag cleared. */
  destroy(): void {
    this.disposed = true;
    if (this.offsetPersistTimer !== null) clearTimeout(this.offsetPersistTimer);
    this.storageUnsubscribe?.();
    this.storageUnsubscribe = null;
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.spaObserver?.stop();
    this.spaObserver = null;
    this.teardownWidgetAndBridge();
    clearInjectedFlag();
  }
}
