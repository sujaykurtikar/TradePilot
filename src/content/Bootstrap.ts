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
import { getLogger } from '../utils/logger';

const log = getLogger('content:bootstrap');

const LAST_BAR_GRACE_MS = 5000;
const LAST_BAR_POLL_MS = 250;
const OFFSET_PERSIST_DEBOUNCE_MS = 400;

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

  private readonly storage = new StorageManager();
  private storageUnsubscribe: (() => void) | null = null;
  private lastKnownEnabled = true;
  private offsetsWereEmpty = true;
  private pendingOffsets: Record<string, Offset> = {};
  private offsetPersistTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.spaObserver?.stop();
    this.spaObserver = null;
    this.teardownWidgetAndBridge();
    clearInjectedFlag();
  }
}
