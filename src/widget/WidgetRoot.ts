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
import type { TradingMode } from '../models/TradingMode';
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
import {
  createOrderPanel,
  type OrderPanelComponent,
  type OrderPanelProps,
} from './components/OrderPanel';
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
  /**
   * Personal mode only. Present ⇒ the standalone order panel is shown
   * (see components/OrderPanel.ts); absent ⇒ it stays hidden. The panel
   * reuses this suggestion's `symbolLabel`, so it isn't repeated here.
   */
  readonly orderEntry?: Omit<OrderPanelProps, 'symbolLabel'> | null;
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
  /** Which on-chart trading mode to start in — defaults to 'strategy' (today's behavior). No on-chart UI for this; the side panel is the only place it's switched. */
  readonly initialTradingMode?: TradingMode;
  /**
   * Pre-trade TP/SL pill drag-end in personal mode ONLY (this.position ===
   * null && tradingMode === 'personal') — the parallel path to
   * onPositionRiskDrag for a trade that hasn't been placed yet. Computes
   * the target price via the exact same bridge math as
   * onPositionRiskDrag; the caller stores it as the personal-mode TP/SL.
   * In strategy mode a pre-trade drag stays purely cosmetic, as today.
   */
  readonly onManualLevelDragEnd?: (variant: 'tp' | 'sl', newPrice: number) => void;
}

const TARGET_TP = 'level-pill-tp';
const TARGET_SL = 'level-pill-sl';
const TARGET_SUGGESTION = 'suggestion-card';
const TARGET_ORDER_PANEL = 'order-panel';

/** Where the free-floating order panel parks by default, inset from the pane's bottom-left. */
const ORDER_PANEL_INSET_X_PX = 24;
const ORDER_PANEL_INSET_Y_PX = 96;
/** Inset the panel is clamped to on all four sides (never dragged fully off the pane). */
const ORDER_PANEL_EDGE_MARGIN_PX = 8;

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
  private readonly orderPanel: OrderPanelComponent;
  private readonly puck: HTMLButtonElement;
  private readonly demoBadge: HTMLDivElement | null = null;
  private suggestion: WidgetSuggestionData;
  private position: DraggablePosition | null = null;
  private readonly onPositionRiskDrag: ((variant: 'tp' | 'sl', newPrice: number) => void) | null;
  private readonly onManualLevelDragEnd: ((variant: 'tp' | 'sl', newPrice: number) => void) | null;
  private tradingMode: TradingMode;
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
  private readonly hLineTp: HTMLDivElement;
  private readonly hLineSl: HTMLDivElement;
  private readonly hLineEntry: HTMLDivElement;
  constructor(opts: WidgetRootOptions) {
    this.suggestion = opts.suggestion;
    this.host = new ShadowHost();
    this.bridge = opts.bridge;
    this.anchorManager = new AnchorManager(opts.bridge, this.dragManager);
    this.stateManager = new StateManager({ collapsed: opts.initialCollapsed ?? false });
    this.onCollapsedChange = opts.onCollapsedChange ?? null;
    this.onPositionRiskDrag = opts.onPositionRiskDrag ?? null;
    this.onManualLevelDragEnd = opts.onManualLevelDragEnd ?? null;
    this.tradingMode = opts.initialTradingMode ?? 'strategy';
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

    // A TP/SL pill's position IS its price: dragging one commits to a new
    // price and zeroes the offset (handleLevelDragEnd, setPosition), so a
    // STORED offset for one can only be a leftover from a build that
    // predates that. Restoring it displaces the pill — and the connector
    // line drawn to it — from the level it labels, which showed up live as
    // a line stretching to a pill that wasn't there (the pill having been
    // pushed off the pane by the same offset). Not persisted either, so
    // the stale values already in chrome.storage stop being rewritten.
    // Only the card carries a cosmetic offset; the pills mirror its dx.
    const isLevel = (id: string): boolean => id === TARGET_TP || id === TARGET_SL;
    if (opts.initialOffsets) {
      for (const [id, offset] of Object.entries(opts.initialOffsets)) {
        if (isLevel(id)) continue;
        this.dragManager.hydrate(id, offset);
      }
    }
    const onOffsetChange = opts.onOffsetChange;
    if (onOffsetChange) {
      this.dragManager.onChange((id, offset) => {
        if (isLevel(id)) return;
        onOffsetChange(id, offset);
      });
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

    this.orderPanel = createOrderPanel({
      symbolLabel: opts.suggestion.symbolLabel,
      lots: opts.suggestion.orderEntry?.lots ?? 1,
      lotSize: opts.suggestion.orderEntry?.lotSize ?? null,
      canDecrementLots: opts.suggestion.orderEntry?.canDecrementLots ?? false,
      onIncrementLots: () => this.suggestion.orderEntry?.onIncrementLots(),
      onDecrementLots: () => this.suggestion.orderEntry?.onDecrementLots(),
      onBuy: () => this.suggestion.orderEntry?.onBuy(),
      onSell: () => this.suggestion.orderEntry?.onSell(),
      ...(opts.suggestion.orderEntry?.disabled === undefined
        ? {}
        : { disabled: opts.suggestion.orderEntry.disabled }),
      ...(opts.suggestion.orderEntry?.buyLabel === undefined
        ? {}
        : { buyLabel: opts.suggestion.orderEntry.buyLabel }),
      ...(opts.suggestion.orderEntry?.sellLabel === undefined
        ? {}
        : { sellLabel: opts.suggestion.orderEntry.sellLabel }),
      ...(opts.suggestion.orderEntry?.buyDisabledReason === undefined
        ? {}
        : { buyDisabledReason: opts.suggestion.orderEntry.buyDisabledReason }),
      ...(opts.suggestion.orderEntry?.sellDisabledReason === undefined
        ? {}
        : { sellDisabledReason: opts.suggestion.orderEntry.sellDisabledReason }),
    });
    this.orderPanel.element.classList.add('tp-positioned', 'tp-positioned--hidden');

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

    // Full-width price lines (like TradingView's own order lines) — one per
    // level, run edge-to-edge across the pane at that level's price so it
    // reads at a glance without following the pill/line down to the label.
    this.hLineTp = document.createElement('div');
    this.hLineTp.className = 'tp-hline tp-hline--tp tp-positioned tp-positioned--hidden';
    this.hLineSl = document.createElement('div');
    this.hLineSl.className = 'tp-hline tp-hline--sl tp-positioned tp-positioned--hidden';
    this.hLineEntry = document.createElement('div');
    this.hLineEntry.className = 'tp-hline tp-hline--entry tp-positioned tp-positioned--hidden';

    this.host.layer.append(
      this.hLineTp,
      this.hLineSl,
      this.hLineEntry,
      this.connectorLineTp,
      this.connectorLineSl,
      this.tpPill.element,
      this.suggestionCard.element,
      this.slPill.element,
      this.orderPanel.element,
      this.puck,
      this.manualBadge,
      this.unprotectedBanner,
    );
    if (this.demoBadge) this.host.layer.appendChild(this.demoBadge);

    // Solo TP/SL drags ride the price axis — horizontal movement would
    // just detach the pill from the connector line for no reason, so it's
    // locked to vertical-only. The group drag below (via the card's icon)
    // is unrestricted.
    this.dragManager.bind(TARGET_TP, this.tpPill.handleElement, { lockAxis: 'x' });
    this.dragManager.bind(TARGET_SL, this.slPill.handleElement, { lockAxis: 'x' });
    // Free-floating: no axis lock and no price anchor — the panel represents
    // no price, so its drag offset is the ONLY thing that moves it.
    this.dragManager.bind(TARGET_ORDER_PANEL, this.orderPanel.handleElement);
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
    // The order panel needs no drag-end handling of its own: it stays exactly
    // where it is dropped (see applyOrderPanel), so its raw drag offset is
    // already the whole answer.
    // Live price-tag update on every pointermove during a TP/SL drag, not
    // just at the end — see displayedPrice()'s doc comment. This is purely
    // a label readout; it does not touch AnchorManager's positioning math
    // (that still runs off effectiveTpPrice()/effectiveSlPrice() directly),
    // so it can't affect the connector line or the pill's actual position.
    this.dragManager.onChange((id) => {
      if (id === TARGET_TP || id === TARGET_SL) this.renderPills();
    });

    // offPaneBehavior: 'hide' — a TP/SL pill sits at its real price and
    // nowhere else; rescaling the price axis until that price is off the
    // visible range takes the pill off-screen with it, the same as a
    // candle at that price. It only ever moves relative to price when the
    // user drags its own handle — never because the chart was rescaled.
    // The connector line stays connected to the real prices (unpinned,
    // clipped at the pane edge in applyConnectorLine), so it keeps
    // stretching to follow the rescale instead of disappearing along with
    // the pill. The card is unconstrained: it rides the live price, which
    // is on-screen by definition.
    this.anchorManager.addTarget({
      id: TARGET_TP,
      element: this.tpPill.element,
      getPrice: () => this.effectiveTpPrice(),
      pinRight: true,
      mirrorOffsetXFrom: TARGET_SUGGESTION,
      offPaneBehavior: 'hide',
    });
    this.anchorManager.addTarget({
      id: TARGET_SL,
      element: this.slPill.element,
      getPrice: () => this.effectiveSlPrice(),
      pinRight: true,
      mirrorOffsetXFrom: TARGET_SUGGESTION,
      offPaneBehavior: 'hide',
    });
    this.anchorManager.addTarget({
      id: TARGET_SUGGESTION,
      element: this.suggestionCard.element,
      getPrice: () => this.suggestion.livePrice(),
      pinRight: true,
    });

    this.anchorManager.onFrame((paneRect) => this.applyConnectorLine(paneRect));
    this.anchorManager.onFrame((paneRect) => this.applyHorizontalLines(paneRect));
    this.anchorManager.onFrame((paneRect) => this.applyOrderPanel(paneRect));

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
    display(this.hLineTp, !collapsed);
    display(this.hLineSl, !collapsed);
    display(this.hLineEntry, !collapsed);
    display(this.orderPanel.element, !collapsed);
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

  /**
   * Applies a trading-mode change that originated elsewhere (side panel
   * toggle, another tab's storage write) — no on-chart UI reflects this
   * directly, it only affects whether handleLevelDragEnd's pre-trade
   * branch treats a drag as cosmetic (strategy mode, unchanged) or as
   * setting the personal-mode TP/SL (personal mode).
   */
  setTradingMode(mode: TradingMode): void {
    this.tradingMode = mode;
  }

  /** Called by content/Bootstrap.ts when new suggestion data arrives (hardcoded for Day-1, live from P5). */
  updateSuggestion(next: WidgetSuggestionData): void {
    this.suggestion = next;
    this.renderPills();
    this.renderSuggestionCard();
    this.renderOrderPanel();
  }

  private renderOrderPanel(): void {
    const order = this.suggestion.orderEntry;
    if (order == null) return; // hidden next frame by applyOrderPanel
    this.orderPanel.update({
      symbolLabel: this.suggestion.symbolLabel,
      lots: order.lots,
      lotSize: order.lotSize,
      canDecrementLots: order.canDecrementLots,
      onIncrementLots: order.onIncrementLots,
      onDecrementLots: order.onDecrementLots,
      onBuy: order.onBuy,
      onSell: order.onSell,
      ...(order.disabled === undefined ? {} : { disabled: order.disabled }),
      ...(order.buyLabel === undefined ? {} : { buyLabel: order.buyLabel }),
      ...(order.sellLabel === undefined ? {} : { sellLabel: order.sellLabel }),
      ...(order.buyDisabledReason === undefined
        ? {}
        : { buyDisabledReason: order.buyDisabledReason }),
      ...(order.sellDisabledReason === undefined
        ? {}
        : { sellDisabledReason: order.sellDisabledReason }),
    });
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

  /**
   * While a TP/SL pill is being dragged, its displayed number should track
   * the price under the pointer right now — same as TradingView's own
   * price-line drag tag — so the user can eyeball where they're trailing
   * the level to before releasing. Falls back to the pre-drag price if the
   * bridge can't resolve a coordinate this frame (§7.1: never guess).
   */
  private displayedPrice(targetId: string, basePrice: number | null): number | null {
    if (!this.dragManager.isDragging(targetId) || basePrice === null) return basePrice;
    const baseY = this.bridge.priceToY(basePrice);
    if (baseY === null) return basePrice;
    const dy = this.dragManager.getOffset(targetId).dy;
    return this.bridge.yToPrice(baseY + dy) ?? basePrice;
  }

  private renderPills(): void {
    this.tpPill.update({
      variant: 'tp',
      price: this.displayedPrice(TARGET_TP, this.effectiveTpPrice()),
      pending: this.position?.tpState.kind === 'pending',
    });
    this.slPill.update({
      variant: 'sl',
      price: this.displayedPrice(TARGET_SL, this.effectiveSlPrice()),
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
    if (id !== TARGET_TP && id !== TARGET_SL) return;
    if (offset.dx === 0 && offset.dy === 0) return; // a zero-delta commit (e.g. a plain click) isn't a drag

    const variant: 'tp' | 'sl' = id === TARGET_TP ? 'tp' : 'sl';
    const currentPrice = variant === 'tp' ? this.effectiveTpPrice() : this.effectiveSlPrice();
    if (currentPrice === null) return; // nothing to drag from — chart/position not ready

    // A pill can only be dragged while it's actually drawn — 'hide' mode
    // means an off-screen level has no handle to grab — so this reads the
    // same Y the pill was rendered at, no clamping needed: the drag moves
    // the price by exactly the pixel distance dragged.
    const paneRect = this.bridge.paneRect();
    const baseY = this.anchorManager.resolveY(currentPrice, paneRect, 'hide');
    if (baseY === null) return; // §7.1: never guess a price from an unavailable coordinate
    const newPrice = this.bridge.yToPrice(baseY + offset.dy);
    if (newPrice === null) return;

    if (this.position === null) {
      // Pre-trade: cosmetic-only in strategy mode (§P3, unchanged), but in
      // personal mode this IS the mechanism for setting the user's own
      // TP/SL — same math as the position-mode branch below, different
      // destination.
      if (this.tradingMode === 'personal') {
        this.onManualLevelDragEnd?.(variant, newPrice);
        // The commit above bakes offset.dy into the new suggestion.tp/sl
        // (via Bootstrap's synchronous updateSuggestion call). The pill's
        // screen offset must be zeroed right after, the same way
        // setPosition() does for the position-mode branch below — otherwise
        // next frame re-adds this SAME dy on top of the already-shifted
        // price, so the pill visibly jumps past where it was dropped.
        this.dragManager.hydrate(id, { dx: 0, dy: 0 });
      }
      return;
    }

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
      ...(this.suggestion.orderEntry ? { orderEntry: this.suggestion.orderEntry } : {}),
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
      // The connector line is positioned every rAF frame via
      // anchorManager.onFrame (applyConnectorLine) — stopping that loop
      // above freezes it at its LAST anchored-mode transform, while the
      // pills separately snap straight to the fixed manual-layout
      // position via applyManualLayout() below. Those two are computed
      // completely differently (live price coordinates vs. a static
      // top-right stack), so left running together the line visibly
      // detaches into a stale diagonal/oversized streak across the
      // chart. Manual layout has no connector geometry of its own, so
      // just hide both segments instead of leaving them stranded.
      this.connectorLineTp.classList.add('tp-positioned--hidden');
      this.connectorLineSl.classList.add('tp-positioned--hidden');
      this.hLineTp.classList.add('tp-positioned--hidden');
      this.hLineSl.classList.add('tp-positioned--hidden');
      this.hLineEntry.classList.add('tp-positioned--hidden');
      // Same reason as the lines above: the panel is positioned from
      // paneRect every frame, and that loop is stopped in manual mode.
      this.orderPanel.element.classList.add('tp-positioned--hidden');
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
    // Read back where AnchorManager actually put each pill this frame,
    // rather than re-deriving it from the prices. The two used to compute
    // their own positions from the same inputs and could still disagree —
    // different edge rules, and a bridge that answers null for an off-pane
    // price instead of a coordinate — which is what left a line drawn to a
    // point with no pill on it, and a line vanishing while its pill was
    // still up. Drag offsets are already folded in here too.
    const tpY = this.anchorManager.connectorAnchorY(TARGET_TP);
    const slY = this.anchorManager.connectorAnchorY(TARGET_SL);
    const pivotY = this.anchorManager.connectorAnchorY(TARGET_SUGGESTION);
    // A pivot (live price / card) that's temporarily unavailable must not
    // tear the connector down — fall back to splitting it at the midpoint.
    const effectivePivotY = pivotY ?? (tpY !== null && slY !== null ? (tpY + slY) / 2 : null);
    if (paneRect === null || effectivePivotY === null) {
      this.connectorLineTp.classList.add('tp-positioned--hidden');
      this.connectorLineSl.classList.add('tp-positioned--hidden');
      return;
    }

    const sharedDx = this.dragManager.getOffset(TARGET_SUGGESTION).dx;
    const x = paneRect.right - CONNECTOR_GUTTER_PX + sharedDx;

    this.applyConnectorSegment(this.connectorLineTp, tpY, effectivePivotY, x, paneRect);
    this.applyConnectorSegment(this.connectorLineSl, slY, effectivePivotY, x, paneRect);
  }

  /**
   * Full-width TP/SL/entry price lines, edge-to-edge across the pane —
   * TradingView's own order-line convention (§ pasted reference screenshot).
   * Reads AnchorManager.drawnY so a level's line is on-screen exactly when
   * its pill is, and never floats to a substitute edge position the way the
   * vertical connector's endpoint does — a bare price line with no pill
   * would be misleading rather than merely incomplete.
   */
  private applyHorizontalLines(paneRect: PaneRectOrNull): void {
    const tpY = this.anchorManager.drawnY(TARGET_TP);
    const slY = this.anchorManager.drawnY(TARGET_SL);
    const entryY = this.anchorManager.drawnY(TARGET_SUGGESTION);
    this.applyHorizontalLine(this.hLineTp, tpY, paneRect);
    this.applyHorizontalLine(this.hLineSl, slY, paneRect);
    this.applyHorizontalLine(this.hLineEntry, entryY, paneRect);
  }

  /**
   * Places the standalone order panel wherever the user last dragged it —
   * free on both axes, no docking, no snap-back (§ user: the reference lets
   * it sit anywhere on the chart). Unlike every other element here it is NOT
   * price-anchored: it represents no price, so a chart scroll or rescale
   * must leave it exactly where it is.
   *
   * Its resting position is expressed relative to the pane's bottom-left
   * corner plus the drag offset, so a pane resize carries it along instead
   * of stranding it against a viewport coordinate that no longer exists.
   * The only constraint is a clamp keeping it inside the pane — without it,
   * a shrinking pane could leave the panel (and therefore its drag grip)
   * unreachable.
   */
  private applyOrderPanel(paneRect: PaneRectOrNull): void {
    const el = this.orderPanel.element;
    // Personal mode only (no orderEntry ⇒ nothing to trade from here), and
    // never while collapsed to the puck or in a confirm step.
    if (this.suggestion.orderEntry == null || paneRect === null) {
      el.classList.add('tp-positioned--hidden');
      return;
    }
    const offset = this.dragManager.getOffset(TARGET_ORDER_PANEL);
    const panelWidth = el.offsetWidth;
    const panelHeight = el.offsetHeight;
    const rawX = paneRect.x + ORDER_PANEL_INSET_X_PX + offset.dx;
    const minX = paneRect.x + ORDER_PANEL_EDGE_MARGIN_PX;
    const maxX = Math.max(minX, paneRect.right - panelWidth - ORDER_PANEL_EDGE_MARGIN_PX);
    const x = Math.min(Math.max(rawX, minX), maxX);
    // Both axes work the same way: a resting position relative to a pane
    // edge, plus the raw drag offset. The panel is anchored by its top-left
    // corner, so the bottom-relative base subtracts its own height —
    // otherwise it would hang however tall it happens to be below the pane.
    // Clamping to the pane keeps it reachable after a resize, but is the
    // ONLY thing that constrains where it can be dropped.
    const rawY = paneRect.bottom - ORDER_PANEL_INSET_Y_PX - panelHeight + offset.dy;
    const minY = paneRect.y + ORDER_PANEL_EDGE_MARGIN_PX;
    const maxY = Math.max(minY, paneRect.bottom - panelHeight - ORDER_PANEL_EDGE_MARGIN_PX);
    const y = Math.min(Math.max(rawY, minY), maxY);
    el.classList.remove('tp-positioned--hidden');
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private applyHorizontalLine(
    element: HTMLElement,
    y: number | null,
    paneRect: PaneRectOrNull,
  ): void {
    if (y === null || paneRect === null) {
      element.classList.add('tp-positioned--hidden');
      return;
    }
    element.classList.remove('tp-positioned--hidden');
    element.style.transform = `translate3d(${paneRect.x}px, ${y}px, 0)`;
    element.style.width = `${paneRect.right - paneRect.x}px`;
  }

  /** One half of the connector, drawn only over the span of it that's on the chart. */
  private applyConnectorSegment(
    element: HTMLElement,
    endY: number | null,
    pivotY: number,
    x: number,
    paneRect: PaneRectOrNull,
  ): void {
    const span = endY === null ? null : this.anchorManager.clipSegmentToPane(endY, pivotY, paneRect);
    if (span === null) {
      element.classList.add('tp-positioned--hidden');
      return;
    }
    element.classList.remove('tp-positioned--hidden');
    element.style.transform = `translate3d(${x}px, ${span.top}px, 0)`;
    element.style.height = `${span.height}px`;
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
    this.orderPanel.destroy();
    this.unsubscribeState?.();
    this.stateManager.destroy();
    this.host.destroy();
    log.info('widget destroyed');
  }
}
