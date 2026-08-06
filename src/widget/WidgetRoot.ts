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
import type { DraggablePosition } from '../models/Position';
import { AnchorManager, type PaneRectOrNull } from './managers/AnchorManager';
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
  /**
   * §P6t: fired when the user finishes dragging a TP/SL pill WHILE a
   * position is set (setPosition()) — never fires pre-trade, where the
   * same pointer-drag is purely cosmetic screen repositioning (§P3).
   * WidgetRoot computes the target price via the bridge; the caller
   * (content/Bootstrap.ts) owns validating it and submitting
   * POST /position/risk.
   */
  readonly onPositionRiskDrag?: (variant: 'tp' | 'sl', newPrice: number) => void;
}

const TARGET_TP = 'level-pill-tp';
const TARGET_SL = 'level-pill-sl';
const TARGET_SUGGESTION = 'suggestion-card';

/** Gutter from right edge of the chart pane — pills/card/line anchor at this X. */
const CONNECTOR_GUTTER_PX = 12;

/** Manual-mode fixed layout — top-right stack, independent of any chart coordinate math (§R-P2). */
const MANUAL_LAYOUT_OFFSETS: Readonly<Record<string, { top: number; rightMargin: number }>> = {
  [TARGET_TP]: { top: 56, rightMargin: 220 },
  [TARGET_SUGGESTION]: { top: 100, rightMargin: 220 },
  [TARGET_SL]: { top: 190, rightMargin: 220 },
};

export class WidgetRoot {
  private readonly host: ShadowHost;
  private readonly bridge: ChartBridge;
  private readonly dragManager = new DragManager();
  private readonly anchorManager: AnchorManager;
  private readonly stateManager: StateManager;
  private readonly tpPill: LevelPillComponent;
  private readonly slPill: LevelPillComponent;
  private readonly suggestionCard: SuggestionCardComponent;
  private readonly puck: HTMLButtonElement;
  private readonly demoBadge: HTMLDivElement | null = null;
  private suggestion: WidgetSuggestionData;
  private position: DraggablePosition | null = null;
  private readonly onPositionRiskDrag: ((variant: 'tp' | 'sl', newPrice: number) => void) | null;
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
  private readonly connectorLineTp: HTMLDivElement;
  private readonly connectorLineSl: HTMLDivElement;

  constructor(opts: WidgetRootOptions) {
    this.suggestion = opts.suggestion;
    this.host = new ShadowHost();
    this.bridge = opts.bridge;
    this.anchorManager = new AnchorManager(opts.bridge, this.dragManager);
    this.stateManager = new StateManager({ collapsed: opts.initialCollapsed ?? false });
    this.onCollapsedChange = opts.onCollapsedChange ?? null;
    this.onPositionRiskDrag = opts.onPositionRiskDrag ?? null;
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

    this.connectorLineTp = document.createElement('div');
    this.connectorLineTp.className = 'tp-connector-line tp-connector-line--tp tp-positioned tp-positioned--hidden';
    this.connectorLineSl = document.createElement('div');
    this.connectorLineSl.className = 'tp-connector-line tp-connector-line--sl tp-positioned tp-positioned--hidden';

    this.host.layer.append(
      this.connectorLineTp,
      this.connectorLineSl,
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
    // The card's own icon still carries the group id's offset (so it stays
    // put if untouched), but dragging it now moves all three elements
    // together as one rigid group — see DragManager.bindGroup.
    this.dragManager.bindGroup(this.suggestionCard.handleElement, [
      TARGET_TP,
      TARGET_SL,
      TARGET_SUGGESTION,
    ]);
    // §P6t: same pointer-drag mechanics as pre-trade cosmetic repositioning
    // (§P3) — this listener only acts when a position is set, turning a
    // committed drag into a price-drag instead of a screen offset.
    this.dragManager.onDragEnd((id, offset) => this.handleLevelDragEnd(id, offset));

    this.anchorManager.addTarget({
      id: TARGET_TP,
      element: this.tpPill.element,
      getPrice: () => this.effectiveTpPrice(),
      pinRight: true,
    });
    this.anchorManager.addTarget({
      id: TARGET_SL,
      element: this.slPill.element,
      getPrice: () => this.effectiveSlPrice(),
      pinRight: true,
    });
    this.anchorManager.addTarget({
      id: TARGET_SUGGESTION,
      element: this.suggestionCard.element,
      getPrice: () => this.suggestion.livePrice(),
      pinRight: true,
    });

    this.anchorManager.onFrame((paneRect) => this.applyConnectorLine(paneRect));

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
    display(this.connectorLineTp, !collapsed);
    display(this.connectorLineSl, !collapsed);
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
    this.renderPills();
    this.renderSuggestionCard();
  }

  /**
   * §P6t: "after Trade is clicked and a position is confirmed, the TP and
   * SL pills switch from following the suggestion to independently
   * anchored at the position's actual sl/tp." Pass null once the position
   * closes to resume following the suggestion.
   *
   * §P6t mid-drag guard ("a poll landing mid-drag must not yank the
   * pill"): whichever of TP/SL is currently being dragged keeps its OLD
   * value from THIS update — the field being dragged is the one thing a
   * concurrent data push must not overwrite.
   */
  setPosition(next: DraggablePosition | null): void {
    let merged = next;
    if (merged !== null) {
      if (this.dragManager.isDragging(TARGET_TP) && this.position !== null) {
        merged = { ...merged, tp: this.position.tp, tpState: this.position.tpState };
      } else {
        // Accepting fresh TP data for a field that ISN'T mid-drag — any
        // leftover offset from a previous drag must not double-count on
        // top of the new anchor (§P6t: avoids a snap-back-then-forward
        // flicker between the optimistic pending price and confirmation).
        this.dragManager.hydrate(TARGET_TP, { dx: 0, dy: 0 });
      }
      if (this.dragManager.isDragging(TARGET_SL) && this.position !== null) {
        merged = { ...merged, sl: this.position.sl, slState: this.position.slState };
      } else {
        this.dragManager.hydrate(TARGET_SL, { dx: 0, dy: 0 });
      }
    }
    const hadPosition = this.position !== null;
    this.position = merged;
    this.renderPills();
    // The card's "Suggested"/"Position" label depends on this.position —
    // only re-render it on an actual open/close transition, not on every
    // poll while a position stays open (avoids redundant DOM writes).
    if (hadPosition !== (merged !== null)) this.renderSuggestionCard();
  }

  private effectiveTpPrice(): number | null {
    if (this.position === null) return this.suggestion.tp;
    return this.position.tpState.kind === 'pending'
      ? this.position.tpState.optimisticPrice
      : this.position.tp;
  }

  private effectiveSlPrice(): number | null {
    if (this.position === null) return this.suggestion.sl;
    return this.position.slState.kind === 'pending'
      ? this.position.slState.optimisticPrice
      : this.position.sl;
  }

  private renderPills(): void {
    this.tpPill.update({
      variant: 'tp',
      price: this.effectiveTpPrice(),
      pending: this.position?.tpState.kind === 'pending',
    });
    this.slPill.update({
      variant: 'sl',
      price: this.effectiveSlPrice(),
      pending: this.position?.slState.kind === 'pending',
    });
    // Anchored mode's visibility comes from AnchorManager reading these
    // same getters every frame; manual mode has no such loop, so new data
    // needs an explicit re-layout to pick up a value going null <-> non-null.
    if (this.mode === 'manual') this.applyManualLayout();
  }

  /**
   * §P6t: the pointer-drag mechanics are identical to pre-trade cosmetic
   * repositioning (§P3/DragManager) — what differs is what happens at
   * commit. With a position set, a committed TP/SL drag converts its
   * screen-space offset into a target PRICE via the bridge, instead of
   * just persisting a cosmetic offset.
   */
  private handleLevelDragEnd(id: string, offset: Offset): void {
    if (this.position === null) return; // pre-trade: purely cosmetic, nothing more to do
    if (id !== TARGET_TP && id !== TARGET_SL) return;
    if (offset.dx === 0 && offset.dy === 0) return; // a zero-delta commit (e.g. a plain click) isn't a drag

    const variant: 'tp' | 'sl' = id === TARGET_TP ? 'tp' : 'sl';
    const currentPrice = variant === 'tp' ? this.effectiveTpPrice() : this.effectiveSlPrice();
    if (currentPrice === null) return; // nothing to drag from — chart/position not ready

    const baseY = this.bridge.priceToY(currentPrice);
    if (baseY === null) return; // §7.1: never guess a price from an unavailable coordinate
    const newPrice = this.bridge.yToPrice(baseY + offset.dy);
    if (newPrice === null) return;

    this.onPositionRiskDrag?.(variant, newPrice);
  }

  private renderSuggestionCard(): void {
    this.suggestionCard.update({
      symbolLabel: this.suggestion.symbolLabel,
      subLabel: this.suggestion.subLabel ?? null,
      tradeDisabled: this.suggestion.tradeDisabled ?? false,
      staleReason: this.suggestion.staleReason ?? null,
      hasPosition: this.position !== null,
      onTrade: this.suggestion.onTrade,
      ...(this.suggestion.onTradeFocusChange
        ? { onTradeFocusChange: this.suggestion.onTradeFocusChange }
        : {}),
      confirm: this.currentConfirm,
    });
    if (this.mode === 'manual') this.applyManualLayout();
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

  /**
   * §7.1: "Data > 15s old or is_fresh===false ⇒ dim + `stale` + Trade
   * disabled." Distinct from the R-OCO banner (that's a safety alert;
   * this is a visual "don't fully trust what you're looking at" cue) and
   * from the "no suggestion" case (fresh data legitimately saying there's
   * nothing to trade right now isn't the same as data we can't vouch
   * for). Applies to the pills and suggestion card only — never to the
   * R-OCO banner or manual/demo badges, which must stay maximally visible.
   */
  setDataStale(stale: boolean): void {
    for (const el of [this.tpPill.element, this.slPill.element, this.suggestionCard.element]) {
      el.classList.toggle('tp-dimmed', stale);
    }
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
  /**
   * Two-tone vertical connector line (§P3 reference screenshot): a thin
   * green segment from entry→TP and a red segment from entry→SL. Positioned
   * each rAF frame via AnchorManager.onFrame so it stays perfectly joined
   * to the pills/card without being its own AnchorTarget.
   */
  private applyConnectorLine(paneRect: PaneRectOrNull): void {
    const tpPrice = this.effectiveTpPrice();
    const pivotPrice = this.suggestion.livePrice();
    const slPrice = this.effectiveSlPrice();

    // The line stays attached to TP and SL as long as both of THOSE are
    // known — a pivot (live price / card) that's temporarily unavailable
    // must not tear the whole connector down, only fall back to splitting
    // it at the midpoint instead of the real entry price.
    if (paneRect === null || tpPrice === null || slPrice === null) {
      this.connectorLineTp.classList.add('tp-positioned--hidden');
      this.connectorLineSl.classList.add('tp-positioned--hidden');
      return;
    }

    const tpY = this.bridge.priceToY(tpPrice);
    const slY = this.bridge.priceToY(slPrice);
    if (tpY === null || slY === null) {
      this.connectorLineTp.classList.add('tp-positioned--hidden');
      this.connectorLineSl.classList.add('tp-positioned--hidden');
      return;
    }
    const pivotY = pivotPrice === null ? null : this.bridge.priceToY(pivotPrice);
    const effectivePivotY = pivotY ?? (tpY + slY) / 2;

    // Include any drag offsets so the line tracks a drag in progress
    const tpDy = this.dragManager.getOffset(TARGET_TP).dy;
    const pivotDy = this.dragManager.getOffset(TARGET_SUGGESTION).dy;
    const slDy = this.dragManager.getOffset(TARGET_SL).dy;
    const sharedDx = this.dragManager.getOffset(TARGET_SUGGESTION).dx;

    const y1 = tpY + tpDy;
    const yPivot = effectivePivotY + pivotDy;
    const y2 = slY + slDy;
    const x = paneRect.right - CONNECTOR_GUTTER_PX + sharedDx;

    // TP segment: from min(y1, yPivot) to max(y1, yPivot)
    this.connectorLineTp.classList.remove('tp-positioned--hidden');
    this.connectorLineTp.style.transform = `translate3d(${x}px, ${Math.min(y1, yPivot)}px, 0)`;
    this.connectorLineTp.style.height = `${Math.abs(yPivot - y1)}px`;

    // SL segment: from min(yPivot, y2) to max(yPivot, y2)
    this.connectorLineSl.classList.remove('tp-positioned--hidden');
    this.connectorLineSl.style.transform = `translate3d(${x}px, ${Math.min(yPivot, y2)}px, 0)`;
    this.connectorLineSl.style.height = `${Math.abs(y2 - yPivot)}px`;
  }

  private applyManualLayout(): void {
    // §7.1/§R-P5: "Missing tp ⇒ hide the TP pill, keep the rest" applies
    // here too, not just in anchored mode — manual mode's whole point is
    // "coordinate math is untrusted," not "content nullability doesn't
    // matter anymore." Anchored mode gets this for free from
    // AnchorManager's null-price-hides logic; manual mode has to check
    // explicitly since it never calls into AnchorManager at all.
    const elements: Record<string, { el: HTMLElement; hasValue: boolean }> = {
      [TARGET_TP]: { el: this.tpPill.element, hasValue: this.effectiveTpPrice() !== null },
      [TARGET_SUGGESTION]: {
        el: this.suggestionCard.element,
        hasValue: this.suggestion.livePrice() !== null,
      },
      [TARGET_SL]: { el: this.slPill.element, hasValue: this.effectiveSlPrice() !== null },
    };
    for (const [id, layout] of Object.entries(MANUAL_LAYOUT_OFFSETS)) {
      const target = elements[id];
      if (target === undefined) continue;
      if (!target.hasValue) {
        target.el.classList.add('tp-positioned--hidden');
        continue;
      }
      const offset = this.dragManager.getOffset(id);
      const x = window.innerWidth - layout.rightMargin + offset.dx;
      const y = layout.top + offset.dy;
      target.el.classList.remove('tp-positioned--hidden');
      target.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
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
