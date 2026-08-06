/**
 * Composes the three independently-positionable elements (§R-P3) into the
 * widget shown on-chart: TP pill above, Suggested card riding the live
 * price, SL pill below (§P3 screenshot). Owns the ShadowHost, DragManager,
 * AnchorManager, and collapse-to-puck state for this one widget instance.
 *
 * Knows nothing about TradingView/Kotak — only the ChartBridge interface
 * (§5.1). Knows nothing about our backend either — suggestion data and the
 * Trade callback are handed in by the caller (content/Bootstrap.ts), which
 * for Day-1 (§6.0) is a hardcoded config object, and from P5/P6 onward is
 * real API data. This class doesn't change between those two states.
 */

import type { ChartBridge } from '../bridge/ChartBridge';
import { AnchorManager } from './managers/AnchorManager';
import { DragManager, type Offset } from './managers/DragManager';
import { StateManager } from './managers/StateManager';
import { ShadowHost } from './ShadowHost';
import { createLevelPill, type LevelPillComponent } from './components/LevelPill';
import {
  createSuggestionCard,
  type SuggestionCardComponent,
  type TradeConfirmDetails,
} from './components/SuggestionCard';
import { showToast } from './components/Toast';
import { getLogger } from '../utils/logger';

const log = getLogger('widget:root');

export interface WidgetSuggestionData {
  readonly symbolLabel: string;
  readonly subLabel?: string | null;
  /** Anchor reference for the card riding the live price — see class header. */
  readonly livePrice: () => number | null;
  readonly tp: number | null;
  readonly sl: number | null;
  readonly tradeDisabled?: boolean;
  readonly staleReason?: string | null;
  readonly onTrade: () => void;
  /** §P6: freeze the suggestion on hover/focus of Trade — levels must not shift mid-decision. */
  readonly onTradeFocusChange?: (focused: boolean) => void;
}

/** §R-P2's degradation ladder: 'anchored' = full price tracking, 'manual' = fixed draggable panel + badge (coordinate math is untrusted, but values are still shown/tradeable). */
export type WidgetMode = 'anchored' | 'manual';

export interface WidgetRootOptions {
  readonly bridge: ChartBridge;
  readonly suggestion: WidgetSuggestionData;
  /** §6.0: Day-1 build must carry a visible "DEMO" badge so it's never mistaken for the hardened version. */
  readonly demoMode: boolean;
  /** §P3 "position and collapse state persisted" — hydration + change hooks, wired to chrome.storage by content/Bootstrap.ts. */
  readonly initialCollapsed?: boolean;
  readonly initialOffsets?: Readonly<Record<string, Offset>>;
  readonly onOffsetChange?: (elementId: string, offset: Offset) => void;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  /** §P2/CapabilityProbe's initial classification — defaults to 'anchored' (Day-1 has no probe wired in yet). */
  readonly initialMode?: WidgetMode;
  readonly initialManualReason?: string;
}

const TARGET_TP = 'level-pill-tp';
const TARGET_SL = 'level-pill-sl';
const TARGET_SUGGESTION = 'suggestion-card';

/** Manual-mode fixed layout — top-right stack, independent of any chart coordinate math (§R-P2). */
const MANUAL_LAYOUT_OFFSETS: Readonly<Record<string, { top: number; rightMargin: number }>> = {
  [TARGET_TP]: { top: 56, rightMargin: 220 },
  [TARGET_SUGGESTION]: { top: 100, rightMargin: 220 },
  [TARGET_SL]: { top: 190, rightMargin: 220 },
};

export class WidgetRoot {
  private readonly host: ShadowHost;
  private readonly dragManager = new DragManager();
  private readonly anchorManager: AnchorManager;
  private readonly stateManager: StateManager;
  private readonly tpPill: LevelPillComponent;
  private readonly slPill: LevelPillComponent;
  private readonly suggestionCard: SuggestionCardComponent;
  private readonly puck: HTMLButtonElement;
  private readonly demoBadge: HTMLDivElement | null = null;
  private suggestion: WidgetSuggestionData;
  private unsubscribeState: (() => void) | null = null;

  private readonly onCollapsedChange: ((collapsed: boolean) => void) | null;
  private mode: WidgetMode;
  private readonly initialManualReason: string;
  private readonly manualBadge: HTMLDivElement;
  private readonly manualBadgeReasonEl: HTMLSpanElement;
  private manualResizeListener: (() => void) | null = null;
  private unsubscribeDragForManual: (() => void) | null = null;
  private currentConfirm: TradeConfirmDetails | null = null;
  private readonly unprotectedBanner: HTMLDivElement;

  constructor(opts: WidgetRootOptions) {
    this.suggestion = opts.suggestion;
    this.host = new ShadowHost();
    this.anchorManager = new AnchorManager(opts.bridge, this.dragManager);
    this.stateManager = new StateManager({ collapsed: opts.initialCollapsed ?? false });
    this.onCollapsedChange = opts.onCollapsedChange ?? null;
    this.mode = opts.initialMode ?? 'anchored';
    this.initialManualReason = opts.initialManualReason ?? '';

    this.manualBadge = document.createElement('div');
    this.manualBadge.className = 'tp-badge-manual';
    this.manualBadge.style.display = 'none';
    const manualBadgeLabel = document.createElement('span');
    manualBadgeLabel.textContent = '⚠ chart link unavailable';
    this.manualBadgeReasonEl = document.createElement('span');
    this.manualBadgeReasonEl.className = 'tp-badge-manual__reason';
    this.manualBadge.append(manualBadgeLabel, this.manualBadgeReasonEl);

    // §3/R-OCO: "the single most dangerous state in the system" — an
    // open position with no backend reachable to enforce its SL/TP.
    // Unmissable, not a subtle tint; hidden by default.
    this.unprotectedBanner = document.createElement('div');
    this.unprotectedBanner.className = 'tp-banner-unprotected';
    this.unprotectedBanner.style.display = 'none';
    this.unprotectedBanner.setAttribute('role', 'alert');

    if (opts.initialOffsets) {
      for (const [id, offset] of Object.entries(opts.initialOffsets)) {
        this.dragManager.hydrate(id, offset);
      }
    }
    if (opts.onOffsetChange) {
      this.dragManager.onChange(opts.onOffsetChange);
    }

    this.tpPill = createLevelPill({ variant: 'tp', price: opts.suggestion.tp });
    this.slPill = createLevelPill({ variant: 'sl', price: opts.suggestion.sl });
    this.suggestionCard = createSuggestionCard({
      symbolLabel: opts.suggestion.symbolLabel,
      subLabel: opts.suggestion.subLabel ?? null,
      tradeDisabled: opts.suggestion.tradeDisabled ?? false,
      staleReason: opts.suggestion.staleReason ?? null,
      onTrade: opts.suggestion.onTrade,
    });

    for (const el of [this.tpPill.element, this.slPill.element, this.suggestionCard.element]) {
      el.classList.add('tp-positioned', 'tp-mount-animate');
    }

    this.puck = document.createElement('button');
    this.puck.type = 'button';
    this.puck.className = 'tp-puck tp-positioned';
    this.puck.textContent = '⚡';
    this.puck.setAttribute('aria-label', 'Expand TradePilot widget');
    this.puck.addEventListener('click', () => this.stateManager.set({ collapsed: false }));

    if (opts.demoMode) {
      this.demoBadge = document.createElement('div');
      this.demoBadge.className = 'tp-badge-demo';
      this.demoBadge.textContent = 'DEMO';
    }

    this.host.layer.append(
      this.tpPill.element,
      this.suggestionCard.element,
      this.slPill.element,
      this.puck,
      this.manualBadge,
      this.unprotectedBanner,
    );
    if (this.demoBadge) this.host.layer.appendChild(this.demoBadge);

    this.dragManager.bind(TARGET_TP, this.tpPill.handleElement);
    this.dragManager.bind(TARGET_SL, this.slPill.handleElement);
    this.dragManager.bind(TARGET_SUGGESTION, this.suggestionCard.handleElement);

    this.anchorManager.addTarget({
      id: TARGET_TP,
      element: this.tpPill.element,
      getPrice: () => this.suggestion.tp,
      pinRight: true,
    });
    this.anchorManager.addTarget({
      id: TARGET_SL,
      element: this.slPill.element,
      getPrice: () => this.suggestion.sl,
      pinRight: true,
    });
    this.anchorManager.addTarget({
      id: TARGET_SUGGESTION,
      element: this.suggestionCard.element,
      getPrice: () => this.suggestion.livePrice(),
      pinRight: true,
    });

    this.unsubscribeState = this.stateManager.subscribe((state) => {
      this.renderCollapseState(state.collapsed);
      this.onCollapsedChange?.(state.collapsed);
    });
    this.renderCollapseState(this.stateManager.get().collapsed);
  }

  private renderCollapseState(collapsed: boolean): void {
    const display = (el: HTMLElement, show: boolean): void => {
      el.style.display = show ? '' : 'none';
    };
    display(this.tpPill.element, !collapsed);
    display(this.slPill.element, !collapsed);
    display(this.suggestionCard.element, !collapsed);
    display(this.puck, collapsed);
  }

  /** Applies a collapse state that originated elsewhere (popup, another tab's storage write) without re-announcing it via onCollapsedChange — that write already happened. */
  setCollapsedExternal(collapsed: boolean): void {
    if (this.stateManager.get().collapsed === collapsed) return;
    this.renderCollapseState(collapsed);
    // Bypass StateManager.set()'s subscriber notification path (which
    // would call onCollapsedChange and write storage right back) by
    // updating state directly — this value already came from storage.
    this.stateManager.hydrate({ collapsed });
  }

  /** Popup's "reset position" (§P1) — clears all drag offsets; AnchorManager picks up the zeroed offsets next frame automatically. */
  resetOffsets(): void {
    this.dragManager.resetAll();
  }

  /** Called by content/Bootstrap.ts when new suggestion data arrives (hardcoded for Day-1, live from P5). */
  updateSuggestion(next: WidgetSuggestionData): void {
    this.suggestion = next;
    this.tpPill.update({ variant: 'tp', price: next.tp });
    this.slPill.update({ variant: 'sl', price: next.sl });
    this.renderSuggestionCard();
  }

  private renderSuggestionCard(): void {
    this.suggestionCard.update({
      symbolLabel: this.suggestion.symbolLabel,
      subLabel: this.suggestion.subLabel ?? null,
      tradeDisabled: this.suggestion.tradeDisabled ?? false,
      staleReason: this.suggestion.staleReason ?? null,
      onTrade: this.suggestion.onTrade,
      ...(this.suggestion.onTradeFocusChange
        ? { onTradeFocusChange: this.suggestion.onTradeFocusChange }
        : {}),
      confirm: this.currentConfirm,
    });
  }

  /**
   * §P6's confirm step: pass a non-null TradeConfirmDetails to switch the
   * Suggested card into the confirmation view (strike/side/lots/entry/
   * SL/TP/₹risk + Confirm/Cancel), null to return to the normal view.
   * Independent of updateSuggestion() — a live data push arriving while
   * a confirm is showing re-merges through renderSuggestionCard() rather
   * than clobbering it (though the caller is expected to have frozen
   * updates during confirm anyway; see Bootstrap.ts).
   */
  setTradeConfirm(details: TradeConfirmDetails | null): void {
    this.currentConfirm = details;
    this.renderSuggestionCard();
  }

  /** §3/R-OCO: unmissable warning that open position(s) have no reachable backend to enforce their SL/TP. */
  setUnprotectedWarning(visible: boolean, message = ''): void {
    this.unprotectedBanner.textContent = message;
    this.unprotectedBanner.style.display = visible ? '' : 'none';
  }

  /** Shows a transient message inside this widget's own Shadow DOM layer (§6.0's Trade-click confirm stub, and reusable by P6's success/error notices). */
  showToast(message: string): void {
    showToast(this.host.layer, message);
  }

  /**
   * Fully hides the widget layer — distinct from the user-driven
   * collapse-to-puck state (StateManager), which persists and is the
   * user's own choice. This is for a degradation case with no user
   * choice involved: §R-P5 "Symbol unmapped: widget hidden with a reason
   * in the popup." Toggling this does not touch collapse state, so
   * un-hiding restores whatever collapse state the user had.
   */
  setHidden(hidden: boolean): void {
    this.host.layer.style.display = hidden ? 'none' : '';
  }

  /**
   * §R-P2's degradation ladder, applied live. Reversible in both
   * directions — a later probe recovering from 'manual' back to
   * 'anchored' resumes the SAME AnchorManager targets (never re-created),
   * and dropping from 'anchored' to 'manual' just stops that loop and
   * switches to the fixed layout. Safe to call repeatedly with the same
   * mode (e.g. a periodic probe re-confirming); each branch just re-applies.
   */
  setMode(mode: WidgetMode, reason = ''): void {
    this.mode = mode;
    if (mode === 'manual') {
      this.anchorManager.stop();
      this.manualBadge.style.display = '';
      this.manualBadgeReasonEl.textContent = reason;
      this.applyManualLayout();
      if (this.manualResizeListener === null) {
        this.manualResizeListener = () => this.applyManualLayout();
        window.addEventListener('resize', this.manualResizeListener);
      }
      if (this.unsubscribeDragForManual === null) {
        this.unsubscribeDragForManual = this.dragManager.onChange(() => this.applyManualLayout());
      }
    } else {
      this.manualBadge.style.display = 'none';
      if (this.manualResizeListener !== null) {
        window.removeEventListener('resize', this.manualResizeListener);
        this.manualResizeListener = null;
      }
      this.unsubscribeDragForManual?.();
      this.unsubscribeDragForManual = null;
      this.anchorManager.start();
    }
  }

  private applyManualLayout(): void {
    const elements: Record<string, HTMLElement> = {
      [TARGET_TP]: this.tpPill.element,
      [TARGET_SUGGESTION]: this.suggestionCard.element,
      [TARGET_SL]: this.slPill.element,
    };
    for (const [id, layout] of Object.entries(MANUAL_LAYOUT_OFFSETS)) {
      const el = elements[id];
      if (el === undefined) continue;
      const offset = this.dragManager.getOffset(id);
      const x = window.innerWidth - layout.rightMargin + offset.dx;
      const y = layout.top + offset.dy;
      el.classList.remove('tp-positioned--hidden');
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }

  async mount(): Promise<void> {
    if (ShadowHost.alreadyMounted()) {
      log.warn('widget host already mounted — refusing to double-mount (§R-P1)');
      return;
    }
    await this.host.loadStyles();
    this.host.mount();
    this.setMode(this.mode, this.initialManualReason);
    log.info('widget mounted', { mode: this.mode });
  }

  /** Full teardown (§7.5/§R-P1) — every listener/observer/rAF released. */
  destroy(): void {
    if (this.manualResizeListener !== null) {
      window.removeEventListener('resize', this.manualResizeListener);
    }
    this.unsubscribeDragForManual?.();
    this.anchorManager.dispose();
    this.dragManager.destroy();
    this.tpPill.destroy();
    this.slPill.destroy();
    this.suggestionCard.destroy();
    this.unsubscribeState?.();
    this.stateManager.destroy();
    this.host.destroy();
    log.info('widget destroyed');
  }
}
