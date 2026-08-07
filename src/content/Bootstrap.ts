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
import { buildDemoSuggestionConfig, DEMO_FALLBACK_SPOT } from './demoSuggestion';
import { waitForChartReady } from './ChartReadyDetector';
import { SpaNavigationObserver } from './SpaNavigationObserver';
import { markInjected, shouldInject, clearInjectedFlag } from './InjectionGuard';
import { StorageManager } from '../core/storage/StorageManager';
import type { StorageSchema } from '../core/storage/schema';
import { isDataUpdateMessage } from '../core/messaging/guards';
import type {
  PlaceOrderRequest,
  PlaceOrderResponse,
  PositionRiskRequest,
  PositionRiskResponse,
  TabVisibilityMessage,
} from '../core/messaging/messages';
import type { MarketDataSnapshot } from '../core/api/types';
import type { Suggestion } from '../models/Suggestion';
import type { TradingMode } from '../models/TradingMode';
import type { DraggablePosition, Position, RiskLevelReconciliationState } from '../models/Position';
import type { TradeConfirmDetails } from '../widget/components/SuggestionCard';
import { getLogger } from '../utils/logger';

const log = getLogger('content:bootstrap');

const LAST_BAR_GRACE_MS = 5000;
const LAST_BAR_POLL_MS = 250;
const OFFSET_PERSIST_DEBOUNCE_MS = 400;
/** A single failed probe is often just a chart redraw/pan/zoom mid-tick — only a sustained outage should tear the widget down. */
const UNAVAILABLE_PROBES_BEFORE_TEARDOWN = 3;
/** Retry interval for the automatic remount loop once the widget is missing (torn down, or an earlier mount attempt failed). */
const REMOUNT_RETRY_MS = 5000;
/** §R-P5: "last success > 15s ago" -> stale. Matches DataPoller's own base poll interval (5s) with real margin. */
const FRESHNESS_WINDOW_MS = 15_000;
/** §10: no lot-size selector exists in the plan's UI (the screenshot shows no quantity stepper) — fixed at 1 until that's scoped. */
const DEFAULT_LOTS = 1;
/** §P6 slippage guard tolerance: the greater of 0.5% or a fixed floor (so a near-zero-priced instrument still gets a sane minimum tolerance). */
const SLIPPAGE_TOLERANCE_FRACTION = 0.005;
const SLIPPAGE_MIN_TOLERANCE = 0.5;
/**
 * §P6t tick size for snapping a dragged price. Not in the documented API
 * contract (§2 doesn't specify one) — 0.05 is NSE's standard index-option
 * tick, used here as a stated assumption, not a confirmed value.
 */
const TICK_SIZE = 0.05;
/** §6 personal-mode strike stepper: clamp to a sane range either side of ATM. */
const MAX_STRIKE_OFFSET_STEPS = 10;

interface ActiveConfirmContext {
  readonly suggestion: Suggestion;
  readonly lots: number;
  readonly lotSize: number | null;
  /**
   * Personal mode's ATM+offset strike, stamped at Trade-click time.
   * Present (even if null) only for a personal-mode confirm; strategy mode
   * omits this field entirely so handleConfirmClick's `!== undefined`
   * check falls through to its existing atmStrike lookup — see §6's
   * "one deliberate exception" note.
   */
  readonly resolvedStrike?: number | null;
}

/** §6 personal mode: direction/strike offset the user picked, and TP/SL they've dragged onto the chart pre-trade. Reset whenever trading mode changes (locally or via storage). */
interface PersonalTradeState {
  readonly direction: 'BUY' | 'SELL' | null;
  readonly strikeOffsetSteps: number;
  readonly tp: number | null;
  readonly sl: number | null;
}

const EMPTY_PERSONAL_STATE: PersonalTradeState = {
  direction: null,
  strikeOffsetSteps: 0,
  tp: null,
  sl: null,
};

/**
 * §P6t: a drag-in-flight for one position/field, held here so it survives
 * concurrent DataPoller pushes that arrive before the server responds —
 * without this, a poll landing between "user released the pill" and "the
 * request resolved" would flash the pill back to the pre-drag value.
 */
interface PendingRiskDrag {
  readonly positionId: string;
  readonly variant: 'tp' | 'sl';
  readonly price: number;
}

async function waitForFirstBar(bridge: BridgeClient, graceMs: number): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < graceMs) {
    const bar = bridge.lastBar();
    if (bar !== null) return bar.close;
    await new Promise((resolve) => setTimeout(resolve, LAST_BAR_POLL_MS));
  }
  return null;
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
  try {
    chrome.runtime.sendMessage(message).catch((error: unknown) => {
      log.debug('tab-visibility report failed (non-fatal)', { error: String(error) });
    });
  } catch (error: unknown) {
    // chrome.runtime.sendMessage throws synchronously (rather than rejecting)
    // when the extension context has been invalidated, e.g. after an
    // extension reload/update while this content script is still injected.
    log.debug('tab-visibility report failed (non-fatal)', { error: String(error) });
  }
}

export class Bootstrap {
  private bridge: BridgeClient | null = null;
  private widget: WidgetRoot | null = null;
  private spaObserver: SpaNavigationObserver | null = null;
  private disposed = false;
  private runToken = 0;
  private consecutiveUnavailableProbes = 0;
  private remountTimer: ReturnType<typeof setTimeout> | null = null;
  private mountInFlight = false;

  private readonly storage = new StorageManager();
  private storageUnsubscribe: (() => void) | null = null;
  private lastKnownEnabled = true;
  private offsetsWereEmpty = true;
  private pendingOffsets: Record<string, Offset> = {};
  private offsetPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPeriodicProbe: (() => void) | null = null;
  private unsubscribeBridgeChange: (() => void) | null = null;

  private hostConfig: InternalApiHostConfig | null = null;
  private latestSnapshot: MarketDataSnapshot | null = null;

  // §6 personal trading mode.
  private tradingMode: TradingMode = 'strategy';
  private personalState: PersonalTradeState = EMPTY_PERSONAL_STATE;
  /** Synthetic Suggestion built from personalState, rebuilt every applyMarketData pass while in personal mode — see buildPersonalSuggestionData(). */
  private personalSuggestion: Suggestion | null = null;
  /** ATM+offset strike resolved alongside personalSuggestion — stamped onto activeConfirmContext so handleConfirmClick doesn't fall back to the bare atmStrike lookup (§6). */
  private personalResolvedStrike: number | null = null;
  private readonly onRuntimeMessage = (message: unknown): void => {
    if (isDataUpdateMessage(message)) {
      this.applyMarketData(message.snapshot);
    }
  };

  // §P6 trade-confirm state.
  private isFrozen = false;
  private frozenSnapshot: MarketDataSnapshot | null = null;
  private confirmShowing = false;
  private activeConfirmContext: ActiveConfirmContext | null = null;
  private readonly onVisibilityChange = (): void => {
    reportTabVisibility();
    // TradingView stops rendering the chart entirely while the tab is
    // hidden (canvases collapse to 0x0), so a widget that went missing
    // while backgrounded should come straight back the moment the tab is
    // visible again — not wait for the next scheduled retry.
    if (document.visibilityState === 'visible' && this.widget === null) {
      void this.runOnce();
    }
  };

  // §P6t trail SL/TP state.
  private pendingRiskDrag: PendingRiskDrag | null = null;

  // §7.7: "widget hidden with a reason in the popup."
  private lastWrittenHiddenReason: string | null = null;

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
    this.tradingMode = state.tradingMode;
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

    // §6: the side panel toggle (or another tab) switched trading mode —
    // sync the on-chart widget the same way widgetCollapsed above does.
    if (next.tradingMode !== this.tradingMode) {
      this.tradingMode = next.tradingMode;
      this.personalState = EMPTY_PERSONAL_STATE;
      this.widget.setTradingMode(next.tradingMode);
      if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
    }
  }

  private async handleNavigation(): Promise<void> {
    log.info('re-bootstrapping after SPA navigation');
    this.teardownWidgetAndBridge();
    if (this.lastKnownEnabled) {
      await this.runOnce();
    }
  }

  /** Guards against overlapping mount attempts (e.g. the visibility handler and the retry timer firing close together), then schedules a retry if the widget still isn't up afterward. */
  private async runOnce(): Promise<void> {
    if (this.mountInFlight) return;
    this.mountInFlight = true;
    try {
      await this.attemptMount();
    } catch (error) {
      // A throw anywhere in attemptMount (e.g. a bridge call landing mid-SPA-
      // re-render) must never silently kill the retry loop — without this
      // catch, an unhandled rejection here means scheduleRemount() below
      // never runs and the widget stays gone until the page is reloaded.
      log.error('mount attempt threw — will retry', { error: String(error) });
    } finally {
      this.mountInFlight = false;
    }
    if (this.widget === null) this.scheduleRemount();
  }

  /** Retries a missing widget on a timer — covers both "torn down after a sustained probe outage" and "chart wasn't ready yet on the last attempt." A page reload should never be necessary. */
  private scheduleRemount(): void {
    if (this.disposed || !this.lastKnownEnabled) return;
    if (this.remountTimer !== null) return;
    if (document.visibilityState !== 'visible') return; // onVisibilityChange retries immediately once it is
    this.remountTimer = setTimeout(() => {
      this.remountTimer = null;
      if (this.disposed || !this.lastKnownEnabled || this.widget !== null) return;
      if (document.visibilityState !== 'visible') return;
      void this.runOnce();
    }, REMOUNT_RETRY_MS);
  }

  private async attemptMount(): Promise<void> {
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
    let initialState = await probe.runOnce();
    if (this.disposed || token !== this.runToken) return;
    // bridge.isAvailable() (waitForChartReady, above) can flip true a tick
    // before the pane element actually has a laid-out rect — e.g. right
    // after an SPA nav or a tab regaining visibility — which fails the
    // probe's priceToY/timeToX checks as "outside pane rect" even though
    // the chart is genuinely fine a moment later. One short retry absorbs
    // that race instead of mounting in manual mode (visible line/pill
    // detachment) for the ~30s until the next periodic re-probe self-heals.
    if (initialState.mode === 'manual') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.disposed || token !== this.runToken) return;
      const retryState = await probe.runOnce();
      if (this.disposed || token !== this.runToken) return;
      if (retryState.mode === 'anchored') initialState = retryState;
    }
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
    this.tradingMode = persistedState.tradingMode;

    const widget = new WidgetRoot({
      bridge,
      demoMode: true,
      initialMode: initialState.mode,
      initialManualReason: initialState.reason,
      initialCollapsed: persistedState.widgetCollapsed,
      initialOffsets: persistedState.widgetOffsets,
      initialTradingMode: this.tradingMode,
      onCollapsedChange: (collapsed) => {
        void this.storage.patch({ widgetCollapsed: collapsed });
      },
      onOffsetChange: (id, offset) => this.persistOffsetDebounced(id, offset),
      onPositionRiskDrag: (variant, newPrice) => this.handlePositionRiskDrag(variant, newPrice),
      onTradingModeChange: (mode) => {
        this.tradingMode = mode;
        this.personalState = EMPTY_PERSONAL_STATE;
        void this.storage.patch({ tradingMode: mode });
        if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
      },
      onManualLevelDragEnd: (variant, newPrice) => {
        this.personalState = { ...this.personalState, [variant]: newPrice };
        if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
      },
      suggestion: {
        symbolLabel: suggestionConfig.strikeLabel,
        subLabel: `Entry ${suggestionConfig.entry}`,
        livePrice: () => bridge.lastBar()?.close ?? null,
        tp: suggestionConfig.tp,
        sl: suggestionConfig.sl,
        tradeDisabled: false,
        staleReason: null,
        // §P6 supersedes the Day-1 toast-only stub the moment the widget
        // exists — even before the first live data push, clicking Trade
        // now goes through the real confirm flow (which will honestly
        // report "no suggestion available" until data arrives, rather
        // than fabricating a demo order).
        onTrade: () => this.handleTradeClick(),
        onTradeFocusChange: (focused) => this.handleTradeFocusChange(focused),
      },
    });
    this.widget = widget;

    await widget.mount();

    // §8.1: re-probe periodically so a vendor deploy mid-session is
    // caught within the interval, not from a bad fill.
    this.stopPeriodicProbe = probe.startPeriodic((state) => this.handleProbeUpdate(state, token));

    // §9 test matrix "Symbol switch / Timeframe switch -> clean re-anchor,
    // no stale numbers": the chart can report a new symbol via the bridge
    // well before the next scheduled poll (up to 30s away under backoff).
    // Re-run the symbol-map check immediately against the cached snapshot
    // — cheap (no network call) and closes the "stale numbers/label for
    // several seconds after a symbol switch" gap. The suggestion CONTENT
    // itself still waits for the next real poll — there is no "refetch
    // now" endpoint — but a newly-unmapped symbol hides the widget right
    // away rather than continuing to show the old symbol's numbers.
    this.unsubscribeBridgeChange = bridge.onChange((reason) => {
      if (reason !== 'symbol' && reason !== 'interval') return;
      if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
    });

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
    // TradingView doesn't render its chart in a backgrounded tab, so every
    // coordinate check fails there for reasons unrelated to whether the
    // bridge actually works — ignore probes entirely while hidden rather
    // than let ordinary tab-switching tear the widget down.
    if (document.visibilityState !== 'visible') return;

    if (state.mode === 'unavailable') {
      this.consecutiveUnavailableProbes += 1;
      if (this.consecutiveUnavailableProbes < UNAVAILABLE_PROBES_BEFORE_TEARDOWN) {
        log.warn('capability probe reported unavailable — riding out a transient blip', {
          reason: state.reason,
          streak: this.consecutiveUnavailableProbes,
        });
        return;
      }
      log.error(
        'capability probe lost the chart bridge across multiple consecutive checks — tearing the widget down',
        { reason: state.reason },
      );
      this.teardownWidgetAndBridge();
      this.scheduleRemount();
      return;
    }

    this.consecutiveUnavailableProbes = 0;
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

    // §3/R-OCO: never suppressed by the trade-confirm freeze below — an
    // unprotected-position warning is a safety signal, not a suggestion.
    this.updateUnprotectedWarning(widget, snapshot);

    // §P6t: switches TP/SL pills to track the open position's actual
    // levels instead of the suggestion, the moment one exists. Also
    // never suppressed by the suggestion-freeze below — a position's
    // real levels are a different concern from a not-yet-confirmed trade.
    widget.setPosition(this.buildDraggablePosition(snapshot.positions[0] ?? null));

    // §R-P5 "unmapped symbol hides the widget rather than guessing."
    const chartSymbol = bridge.symbol();
    const mappedSymbol = chartSymbol !== null ? (hostConfig.symbolMap[chartSymbol] ?? null) : null;
    if (chartSymbol !== null && mappedSymbol === null) {
      log.warn('chart symbol has no entry in the symbol map — hiding widget', { chartSymbol });
      widget.setHidden(true);
      // §7.7: "widget hidden with a reason in the popup" — this is the
      // one place that reason gets written; popup.ts reads it back.
      this.setWidgetHiddenReason(`Symbol "${chartSymbol}" is not in the symbol map.`);
      return;
    }
    widget.setHidden(false);
    this.setWidgetHiddenReason(null);

    // §P6: "levels must not shift between the decision and the click" —
    // while the user is hovering Trade or has a confirm open, the
    // displayed suggestion is frozen; fresh pushes still update
    // latestSnapshot (read at confirm time for the slippage check) but
    // don't touch what's rendered until the freeze lifts.
    if (this.isFrozen) return;

    const fresh = isSnapshotFresh(snapshot, Date.now());
    // §7.1: "dim + stale + Trade disabled" — the dim is specifically for
    // genuinely stale data, not for a fresh "no suggestion right now".
    widget.setDataStale(!fresh);

    // §6: personal mode never looks at snapshot.suggestion — the card is
    // built entirely from the user's own picks + chartContext instead.
    if (this.tradingMode === 'personal') {
      widget.updateSuggestion(this.buildPersonalSuggestionData(snapshot, mappedSymbol));
      return;
    }

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
      onTrade: () => this.handleTradeClick(),
      onTradeFocusChange: (focused) => this.handleTradeFocusChange(focused),
    };
    widget.updateSuggestion(suggestionData);
  }

  /**
   * §6: builds the on-chart card entirely from personalState + the
   * snapshot's chartContext — never from snapshot.suggestion. Also
   * rebuilds `personalSuggestion`/`personalResolvedStrike`, the synthetic
   * Suggestion-shaped object that lets handleTradeClick/handleConfirmClick
   * reuse the existing confirm/submit pipeline completely unchanged (§R-P6)
   * — only where direction/strike/sl/tp come from differs.
   */
  private buildPersonalSuggestionData(
    snapshot: MarketDataSnapshot,
    mappedSymbol: string | null,
  ): WidgetSuggestionData {
    const atmStrike = snapshot.chartContext?.atmStrike ?? null;
    const strikeInterval = snapshot.chartContext?.strikeInterval ?? null;
    // §7.1 "no ?? 0, ever": never fabricate a strike when the chart hasn't
    // told us the ATM/interval yet — stays null, card shows staleReason.
    const strike =
      atmStrike !== null && strikeInterval !== null
        ? atmStrike + strikeInterval * this.personalState.strikeOffsetSteps
        : null;
    const optionType: 'CE' | 'PE' | null =
      this.personalState.direction === 'BUY'
        ? 'CE'
        : this.personalState.direction === 'SELL'
          ? 'PE'
          : null;

    const symbolLabel =
      mappedSymbol !== null && optionType !== null && strike !== null
        ? `${mappedSymbol} ${optionType}`
        : (mappedSymbol ?? 'TradePilot');

    const livePrice = this.bridge?.lastBar()?.close ?? null;
    const direction = this.personalState.direction;

    this.personalResolvedStrike = strike;
    this.personalSuggestion =
      direction !== null && optionType !== null && livePrice !== null && mappedSymbol !== null
        ? {
            direction,
            recommendedSymbol: mappedSymbol,
            recommendedOptionType: optionType,
            recommendedLtp: livePrice,
            sl: this.personalState.sl,
            tp: this.personalState.tp,
            compositeScore: null,
            rationale: ['Personal — manually entered, no strategy suggestion.'],
            computedAtPrice: livePrice,
            receivedAtMs: Date.now(),
          }
        : null;

    return {
      symbolLabel,
      subLabel: livePrice !== null ? `LTP ${livePrice}` : null,
      livePrice: () => this.bridge?.lastBar()?.close ?? null,
      // Straight from personalState — null until the user drags a level.
      // Never defaulted to a computed percentage (§6's explicit product
      // decision: the user drags to set TP/SL, full stop).
      tp: this.personalState.tp,
      sl: this.personalState.sl,
      tradeDisabled: direction === null || strike === null,
      staleReason: strike === null ? 'waiting for chart data' : null,
      onTrade: () => this.handleTradeClick(),
      onTradeFocusChange: (focused) => this.handleTradeFocusChange(focused),
      personalEntry: {
        direction: this.personalState.direction,
        strikeOffsetSteps: this.personalState.strikeOffsetSteps,
        onPickDirection: (picked) => this.handlePersonalPickDirection(picked),
        onStepStrike: (delta) => this.handlePersonalStepStrike(delta),
      },
    };
  }

  /** §6: picking a side resets the strike stepper — same as (re-)entering personal mode. */
  private handlePersonalPickDirection(direction: 'BUY' | 'SELL'): void {
    this.personalState = { ...this.personalState, direction, strikeOffsetSteps: 0 };
    if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
  }

  private handlePersonalStepStrike(delta: 1 | -1): void {
    const next = Math.max(
      -MAX_STRIKE_OFFSET_STEPS,
      Math.min(MAX_STRIKE_OFFSET_STEPS, this.personalState.strikeOffsetSteps + delta),
    );
    this.personalState = { ...this.personalState, strikeOffsetSteps: next };
    if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
  }

  /** §3/R-OCO: "the single most dangerous state in the system" — open position(s) with no reachable backend to enforce their SL/TP. */
  private updateUnprotectedWarning(widget: WidgetRoot, snapshot: MarketDataSnapshot): void {
    const hasPositions = snapshot.positions.length > 0;
    const fresh = isSnapshotFresh(snapshot, Date.now());
    if (hasPositions && !fresh) {
      widget.setUnprotectedWarning(
        true,
        `⚠ Backend unreachable — ${snapshot.positions.length} open position(s) unprotected!`,
      );
    } else {
      widget.setUnprotectedWarning(false);
    }
  }

  /**
   * Converts a plain Position (from the poll snapshot) into the
   * DraggablePosition WidgetRoot renders, overlaying any drag currently
   * in flight (§P6t's mid-drag/concurrent-poll guard — see
   * PendingRiskDrag's doc comment).
   */
  private buildDraggablePosition(position: Position | null): DraggablePosition | null {
    if (position === null) return null;
    const confirmed: RiskLevelReconciliationState = { kind: 'confirmed' };
    let tpState: RiskLevelReconciliationState = confirmed;
    let slState: RiskLevelReconciliationState = confirmed;
    const pending = this.pendingRiskDrag;
    if (pending !== null && pending.positionId === position.positionId) {
      if (pending.variant === 'tp') tpState = { kind: 'pending', optimisticPrice: pending.price };
      if (pending.variant === 'sl') slState = { kind: 'pending', optimisticPrice: pending.price };
    }
    return { ...position, tpState, slState };
  }

  /**
   * §P6t tick-size snap + best-effort side-of-entry validation. Position
   * (§2) carries no explicit direction field — `delta`'s sign is used as
   * a directionality proxy (positive ~ long call/bullish, negative ~ long
   * put/bearish). This is a stated heuristic, not a guarantee; the server
   * remains the authoritative validator regardless.
   */
  private validateSideOfEntry(position: Position, variant: 'tp' | 'sl', price: number): boolean {
    if (position.entrySpot === null) return true; // nothing to validate against — don't block
    const bullish = (position.delta ?? 0) >= 0;
    const aboveEntry = price > position.entrySpot;
    return variant === 'tp' ? aboveEntry === bullish : aboveEntry !== bullish;
  }

  /**
   * §P6t: fired by WidgetRoot once a TP/SL pill drag commits while a
   * position is set. Snaps to tick, validates side-of-entry, shows an
   * optimistic pending state immediately, then submits exactly once
   * (§R-P6t applies R-P6's idempotency/no-auto-retry rules here).
   */
  private handlePositionRiskDrag(variant: 'tp' | 'sl', rawPrice: number): void {
    const widget = this.widget;
    const snapshot = this.latestSnapshot;
    const position = snapshot?.positions[0] ?? null;
    if (widget === null || snapshot === null || position === null) return;

    const price = Math.round(rawPrice / TICK_SIZE) * TICK_SIZE;

    if (!this.validateSideOfEntry(position, variant, price)) {
      widget.showToast(
        `${variant.toUpperCase()} must stay on the correct side of entry — drag rejected.`,
      );
      widget.setPosition(this.buildDraggablePosition(position)); // snap back — no pendingRiskDrag was ever set
      return;
    }

    // §R-P6t: "If the backend is unreachable while a position is open,
    // dragging is disabled entirely (can't safely change a stop you
    // can't confirm)."
    if (!isSnapshotFresh(snapshot, Date.now())) {
      widget.showToast('Backend unreachable — cannot adjust SL/TP right now.');
      widget.setPosition(this.buildDraggablePosition(position));
      return;
    }

    this.pendingRiskDrag = { positionId: position.positionId, variant, price };
    widget.setPosition(this.buildDraggablePosition(position));

    void this.submitPositionRisk(position, variant, price);
  }

  private async submitPositionRisk(
    position: Position,
    variant: 'tp' | 'sl',
    price: number,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const request: PositionRiskRequest =
      variant === 'tp'
        ? {
            type: 'tradepilot/position-risk',
            requestId,
            positionId: position.positionId,
            account: position.account,
            tp: price,
          }
        : {
            type: 'tradepilot/position-risk',
            requestId,
            positionId: position.positionId,
            account: position.account,
            sl: price,
          };

    let response: PositionRiskResponse | null = null;
    try {
      const rawResponse: PositionRiskResponse | undefined =
        await chrome.runtime.sendMessage(request);
      response = rawResponse ?? null;
    } catch (error) {
      log.error('position-risk submission failed to reach the service worker', {
        requestId,
        error: String(error),
      });
    }

    // Only clear the pending marker if it's still THIS drag — a newer
    // drag on the same field may have already superseded it.
    const stillCurrent =
      this.pendingRiskDrag?.positionId === position.positionId &&
      this.pendingRiskDrag.variant === variant &&
      this.pendingRiskDrag.price === price;
    if (stillCurrent) this.pendingRiskDrag = null;

    if (response === null || response.outcome !== 'accepted') {
      // §P6t: "Backend rejects a dragged level -> Pill snaps back to
      // last confirmed value, reason shown." Never leave the UI showing
      // a level the backend didn't actually accept.
      const reason = response?.message ?? 'Unknown — check positions.';
      this.widget?.showToast(`${variant.toUpperCase()} update failed: ${reason}`);
    }

    // Re-render from whatever the latest snapshot currently says — either
    // the next poll has already caught up to the new confirmed value, or
    // (on rejection) this correctly reverts to the last server-known one.
    if (stillCurrent && this.latestSnapshot !== null) {
      const latestPosition = this.latestSnapshot.positions.find(
        (p) => p.positionId === position.positionId,
      );
      this.widget?.setPosition(this.buildDraggablePosition(latestPosition ?? position));
    }
  }

  private handleTradeFocusChange(focused: boolean): void {
    if (focused) {
      this.isFrozen = true;
      this.frozenSnapshot = this.latestSnapshot;
      return;
    }
    // A hidden confirm-view Trade button can fire blur/mouseleave as a
    // side effect of the DOM swap into the confirm view — don't let that
    // unfreeze mid-confirm.
    if (this.confirmShowing) return;
    this.isFrozen = false;
    this.frozenSnapshot = null;
    if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
  }

  private buildTradeConfirmDetails(submitting: boolean): TradeConfirmDetails | null {
    const ctx = this.activeConfirmContext;
    const entryPrice = ctx?.suggestion.recommendedLtp ?? null;
    if (ctx === null || entryPrice === null) return null;
    const { suggestion, lots, lotSize } = ctx;
    const riskRupees =
      suggestion.sl !== null && lotSize !== null
        ? Math.abs(entryPrice - suggestion.sl) * lotSize * lots
        : null;
    const optionSuffix = suggestion.recommendedOptionType
      ? ` ${suggestion.recommendedOptionType}`
      : '';
    return {
      direction: suggestion.direction,
      strikeLabel: `${suggestion.recommendedSymbol}${optionSuffix}`,
      lots,
      entryPrice,
      sl: suggestion.sl,
      tp: suggestion.tp,
      riskRupees,
      submitting,
      onConfirm: () => {
        void this.handleConfirmClick();
      },
      onCancel: () => this.resetConfirmState(),
    };
  }

  private handleTradeClick(): void {
    const widget = this.widget;
    if (widget === null) return;

    // Freeze now even if hover/focus somehow didn't fire first (e.g.
    // keyboard activation without a preceding pointer hover).
    this.isFrozen = true;
    const snapshot = this.frozenSnapshot ?? this.latestSnapshot;
    this.frozenSnapshot = snapshot;
    // §6: personal mode reads the synthetic Suggestion built alongside
    // personalState (buildPersonalSuggestionData) instead of the
    // snapshot's backend-computed one — everything downstream of this line
    // (confirm view, slippage guard, submit) is identical either way.
    const suggestion =
      this.tradingMode === 'personal' ? this.personalSuggestion : (snapshot?.suggestion ?? null);
    if (suggestion === null || suggestion.recommendedLtp === null) {
      widget.showToast(
        this.tradingMode === 'personal'
          ? 'Pick a direction and wait for live chart data before trading'
          : 'No suggestion available to trade',
      );
      this.isFrozen = false;
      this.frozenSnapshot = null;
      return;
    }

    this.activeConfirmContext = {
      suggestion,
      lots: DEFAULT_LOTS,
      lotSize: snapshot?.chartContext?.lotSize ?? null,
      ...(this.tradingMode === 'personal' ? { resolvedStrike: this.personalResolvedStrike } : {}),
    };
    this.confirmShowing = true;
    widget.setTradeConfirm(this.buildTradeConfirmDetails(false));
  }

  private resetConfirmState(): void {
    this.confirmShowing = false;
    this.activeConfirmContext = null;
    this.isFrozen = false;
    this.frozenSnapshot = null;
    this.widget?.setTradeConfirm(null);
    if (this.latestSnapshot !== null) this.applyMarketData(this.latestSnapshot);
  }

  /**
   * §R-P6 — the highest-stakes call in the project. Idempotency key
   * generated fresh here, exactly once per confirm click. No auto-retry:
   * this fires the request exactly once and reports whatever comes back,
   * including an honest 'ambiguous' outcome rather than guessing.
   */
  private async handleConfirmClick(): Promise<void> {
    const widget = this.widget;
    const bridge = this.bridge;
    const ctx = this.activeConfirmContext;
    const entryPrice = ctx?.suggestion.recommendedLtp ?? null;
    if (widget === null || ctx === null || entryPrice === null) {
      this.resetConfirmState();
      return;
    }
    const { suggestion, lots } = ctx;

    // §P6 slippage guard: the suggestion is stamped with the price it was
    // computed at (Suggestion.computedAtPrice); if live price has since
    // moved beyond tolerance, block and make the user re-click Trade to
    // pick up fresh levels rather than submitting against a stale price.
    const livePrice = bridge?.lastBar()?.close ?? null;
    const referencePrice = suggestion.computedAtPrice ?? entryPrice;
    const tolerance = Math.max(
      referencePrice * SLIPPAGE_TOLERANCE_FRACTION,
      SLIPPAGE_MIN_TOLERANCE,
    );
    if (livePrice !== null && Math.abs(livePrice - referencePrice) > tolerance) {
      widget.showToast(
        'Price moved since this suggestion was computed — click Trade again to refresh.',
      );
      this.resetConfirmState();
      return;
    }

    // §2's /recommend response has no explicit strike field — the ATM
    // strike from /chart/state is the only numeric strike the documented
    // API surface actually provides. Documented assumption, not a
    // guess made silently.
    //
    // §6 exception: a personal-mode confirm stamps its ATM+offset strike
    // onto activeConfirmContext.resolvedStrike (even when that resolves to
    // null — chart data not ready yet), so `!== undefined` here means
    // "this is a personal-mode confirm, use its own resolved strike,
    // never silently substitute the bare ATM." Strategy mode never sets
    // the field at all, so it falls through to the lookup above unchanged.
    const strike =
      ctx.resolvedStrike !== undefined
        ? ctx.resolvedStrike
        : (this.latestSnapshot?.chartContext?.atmStrike ?? null);
    if (suggestion.recommendedOptionType === null || strike === null) {
      widget.showToast('Cannot place order — missing strike or option type.');
      this.resetConfirmState();
      return;
    }

    widget.setTradeConfirm(this.buildTradeConfirmDetails(true)); // §R-P6 disable-on-submit

    const clientOrderId = crypto.randomUUID();
    const request: PlaceOrderRequest = {
      type: 'tradepilot/place-order',
      clientOrderId,
      direction: suggestion.direction,
      lots,
      strike,
      optionType: suggestion.recommendedOptionType,
      sl: suggestion.sl,
      tp: suggestion.tp,
      // Paper is the default and the only wired path — see
      // OrderService.ts's doc comment on why live isn't guessed at.
      paperMode: true,
    };

    let response: PlaceOrderResponse | null = null;
    try {
      const rawResponse: PlaceOrderResponse | undefined = await chrome.runtime.sendMessage(request);
      response = rawResponse ?? null;
    } catch (error) {
      log.error('order submission failed to reach the service worker', {
        clientOrderId,
        error: String(error),
      });
    }

    if (response === null) {
      widget.showToast('Unknown — check positions. Could not reach the extension background.');
    } else if (response.outcome === 'accepted') {
      const optionSuffix = suggestion.recommendedOptionType
        ? ` ${suggestion.recommendedOptionType}`
        : '';
      widget.showToast(
        `Order placed: ${suggestion.direction} ${lots}× ${suggestion.recommendedSymbol}${optionSuffix}`,
      );
    } else {
      // Covers both 'rejected' and 'ambiguous' — §R-P6: inline error, widget stays usable, never a silent failure.
      widget.showToast(response.message);
    }

    this.resetConfirmState();
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

  /** Debounces against redundant writes — applyMarketData calls this every poll (5-30s) even when nothing changed. */
  private setWidgetHiddenReason(reason: string | null): void {
    if (reason === this.lastWrittenHiddenReason) return;
    this.lastWrittenHiddenReason = reason;
    void this.storage.patch({ widgetHiddenReason: reason });
  }

  private teardownWidgetAndBridge(): void {
    this.stopPeriodicProbe?.();
    this.stopPeriodicProbe = null;
    this.unsubscribeBridgeChange?.();
    this.unsubscribeBridgeChange = null;
    this.widget?.destroy();
    this.widget = null;
    this.bridge?.dispose();
    this.bridge = null;
    this.consecutiveUnavailableProbes = 0;
    // Invalidates any mount attempt still in flight (e.g. an in-progress
    // waitForChartReady/probe from a stale attemptMount call).
    this.runToken += 1;
    // The widget is gone for reasons unrelated to symbol mapping (nav,
    // disable, teardown) — a stale "hidden because X" would mislead the
    // popup into blaming a cause that may no longer apply.
    this.setWidgetHiddenReason(null);
  }

  /** Full teardown (§7.5/§R-P1) — everything released, injected flag cleared. */
  destroy(): void {
    this.disposed = true;
    if (this.offsetPersistTimer !== null) clearTimeout(this.offsetPersistTimer);
    if (this.remountTimer !== null) clearTimeout(this.remountTimer);
    this.remountTimer = null;
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
