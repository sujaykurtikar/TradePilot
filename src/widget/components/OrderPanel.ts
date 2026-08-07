/**
 * Personal-mode order-entry panel (§ user reference screenshot) — a
 * standalone, free-floating on-chart panel, NOT part of the Suggested card.
 *
 * Layout/metrics mirror the Zing Trade extension's own "margin trade widget"
 * (its `lemonn-margin-trade-widget`): a tinted header strip carrying the
 * symbol, the Market/Limit segmented pill and a 6-dot grip, over a body of
 * three equal columns — Buy / qty stepper / Sell — each control 104×32 with
 * an 8px radius and a caption underneath. The reference styles everything
 * inline from a JS token map; we keep the same numbers but drive them from
 * widget.css so the panel still themes off tokens.css like the rest of the
 * widget.
 *
 * Deliberately not price-anchored: unlike the TP/SL pills and the Suggested
 * card, this panel represents no price, so it stays wherever the user
 * dropped it while the chart scrolls or rescales. Placement is free on both
 * axes — no edge dock, no snap-back — clamped only to the pane so the grip
 * can't end up off-screen (see WidgetRoot.applyOrderPanel).
 *
 * Market orders only. The Limit tab is rendered but visibly disabled — the
 * order pipeline has no limit-order path yet, and a tab that silently placed
 * a market order instead would be the worst possible outcome here.
 *
 * Margin/Funds sub-labels are shown as "—" rather than omitted (§ user
 * request to match the reference layout) — that's an honest "not available"
 * indicator, not a fabricated number, so it doesn't conflict with §7.1's
 * "never invent a figure" rule the way a guessed margin amount would.
 *
 * Buy/Sell → Exit: when a position is already open, the button that would
 * close it relabels to "Exit" (matching the reference). It's rendered
 * disabled with a reason (same treatment as the Limit tab) because the
 * extension has no wired call for closing a position yet — the backend's
 * square_off/flatten endpoint exists (IMPLEMENTATION_PLAN.md §2) but has no
 * documented per-call request contract, and guessing one for an order-
 * management call is exactly what §7.1/R-P6 says not to do. The OTHER
 * button is disabled too, with a different reason — today, clicking it
 * while a position is open would just fire a second entry order (there's
 * no add-to-position or hedge support), so blocking it here closes that gap
 * rather than leaving it as a live footgun.
 */

import type { Destroyable } from './IconButton';

export interface OrderPanelProps {
  /** e.g. "24050 CE" — the contract the Buy/Sell buttons would trade. */
  readonly symbolLabel: string;
  readonly lots: number;
  /** Contracts per lot (e.g. 75 for NIFTY) — null hides the raw-quantity line, keeping just "N Lots" (§7.1: no guessing a lot size). */
  readonly lotSize: number | null;
  readonly canDecrementLots: boolean;
  readonly onIncrementLots: () => void;
  readonly onDecrementLots: () => void;
  readonly onBuy: () => void;
  readonly onSell: () => void;
  /** Blocks every action — e.g. no live chart price to trade against yet. */
  readonly disabled?: boolean;
  /** Defaults to "Buy at Mkt" / "Sell at Mkt" — overridden to "Exit" when this button would close an open position. */
  readonly buyLabel?: string;
  readonly sellLabel?: string;
  /** Non-null disables the Buy button specifically, with this as the tooltip reason — independent of the blanket `disabled`. */
  readonly buyDisabledReason?: string | null;
  readonly sellDisabledReason?: string | null;
}

export interface OrderPanelComponent extends Destroyable {
  readonly element: HTMLDivElement;
  /** The drag grip, bound by WidgetRoot's DragManager. */
  readonly handleElement: HTMLElement;
  update(props: OrderPanelProps): void;
}

/**
 * Grip / stepper glyphs as inline SVG rather than text (⠿, –, +), matching
 * the reference's crisp 14px icons — braille and en-dash glyphs render at
 * whatever weight the host page's font happens to give them. `currentColor`
 * keeps them themeable from widget.css. Static markup only, no interpolation.
 */
const GRIP_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <circle cx="5" cy="3" r="1.3" fill="currentColor"/><circle cx="11" cy="3" r="1.3" fill="currentColor"/>
  <circle cx="5" cy="8" r="1.3" fill="currentColor"/><circle cx="11" cy="8" r="1.3" fill="currentColor"/>
  <circle cx="5" cy="13" r="1.3" fill="currentColor"/><circle cx="11" cy="13" r="1.3" fill="currentColor"/>
</svg>`;
const MINUS_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="pointer-events:none">
  <path d="M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const PLUS_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="pointer-events:none">
  <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export function createOrderPanel(initial: OrderPanelProps): OrderPanelComponent {
  const root = document.createElement('div');
  root.className = 'tp-order-panel';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Order entry');

  // ---- header strip: symbol + Market/Limit + grip ----
  const topRow = document.createElement('div');
  topRow.className = 'tp-order-panel__header';

  const icon = document.createElement('span');
  icon.className = 'tp-order-panel__icon';
  icon.textContent = '⇄';
  icon.setAttribute('aria-hidden', 'true');

  const symbol = document.createElement('div');
  symbol.className = 'tp-order-panel__symbol';

  const typeTabs = document.createElement('div');
  typeTabs.className = 'tp-order-panel__type-tabs';
  const marketTab = document.createElement('span');
  marketTab.className = 'tp-order-panel__type-tab tp-order-panel__type-tab--active';
  marketTab.textContent = 'Market';
  const limitTab = document.createElement('span');
  limitTab.className = 'tp-order-panel__type-tab tp-order-panel__type-tab--disabled';
  limitTab.textContent = 'Limit';
  limitTab.title = 'Limit orders are not available yet';
  typeTabs.append(marketTab, limitTab);

  // The grip lives in the top row's trailing corner, matching the
  // reference's ⋮⋮ affordance.
  const handle = document.createElement('span');
  handle.className = 'tp-order-panel__handle';
  handle.innerHTML = GRIP_SVG;
  handle.title = 'Drag';
  handle.setAttribute('aria-label', 'Drag order panel');

  topRow.append(icon, symbol, typeTabs, handle);

  // ---- body: Buy | qty stepper | Sell, each with a sub-label ----
  const bottomRow = document.createElement('div');
  bottomRow.className = 'tp-order-panel__body';

  function makeColumn(): HTMLDivElement {
    const col = document.createElement('div');
    col.className = 'tp-order-panel__col';
    return col;
  }
  function makeSubLabel(text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'tp-order-panel__sublabel';
    el.textContent = text;
    el.title = 'Requires broker account data, not available yet';
    return el;
  }

  const buyCol = makeColumn();
  const buyBtn = document.createElement('button');
  buyBtn.type = 'button';
  buyBtn.className = 'tp-order-panel__btn tp-order-panel__btn--buy';
  buyBtn.textContent = 'Buy at Mkt';
  const buyMarginLabel = makeSubLabel('Margin: —');
  buyCol.append(buyBtn, buyMarginLabel);

  const qtyCol = makeColumn();
  const qtyWrap = document.createElement('div');
  qtyWrap.className = 'tp-order-panel__qty';
  const qtyMinus = document.createElement('button');
  qtyMinus.type = 'button';
  qtyMinus.className = 'tp-order-panel__qty-btn';
  qtyMinus.innerHTML = MINUS_SVG;
  qtyMinus.setAttribute('aria-label', 'Decrease lots');
  const qtyNumbers = document.createElement('span');
  qtyNumbers.className = 'tp-order-panel__qty-numbers';
  const qtyNumber = document.createElement('span');
  qtyNumber.className = 'tp-order-panel__qty-num';
  const qtyLotLabel = document.createElement('span');
  qtyLotLabel.className = 'tp-order-panel__qty-lot';
  qtyNumbers.append(qtyNumber, qtyLotLabel);
  const qtyPlus = document.createElement('button');
  qtyPlus.type = 'button';
  qtyPlus.className = 'tp-order-panel__qty-btn';
  qtyPlus.innerHTML = PLUS_SVG;
  qtyPlus.setAttribute('aria-label', 'Increase lots');
  qtyWrap.append(qtyMinus, qtyNumbers, qtyPlus);
  const fundsLabel = makeSubLabel('Funds: —');
  qtyCol.append(qtyWrap, fundsLabel);

  const sellCol = makeColumn();
  const sellBtn = document.createElement('button');
  sellBtn.type = 'button';
  sellBtn.className = 'tp-order-panel__btn tp-order-panel__btn--sell';
  sellBtn.textContent = 'Sell at Mkt';
  const sellMarginLabel = makeSubLabel('Margin: —');
  sellCol.append(sellBtn, sellMarginLabel);

  bottomRow.append(buyCol, qtyCol, sellCol);

  root.append(topRow, bottomRow);

  let currentProps: OrderPanelProps = initial;

  const onMinus = (): void => {
    if (qtyMinus.disabled) return;
    currentProps.onDecrementLots();
  };
  const onPlus = (): void => {
    if (qtyPlus.disabled) return;
    currentProps.onIncrementLots();
  };
  const onBuy = (): void => {
    if (buyBtn.disabled) return;
    currentProps.onBuy();
  };
  const onSell = (): void => {
    if (sellBtn.disabled) return;
    currentProps.onSell();
  };

  qtyMinus.addEventListener('click', onMinus);
  qtyPlus.addEventListener('click', onPlus);
  buyBtn.addEventListener('click', onBuy);
  sellBtn.addEventListener('click', onSell);

  function render(props: OrderPanelProps): void {
    currentProps = props;
    symbol.textContent = props.symbolLabel;

    const lotWord = `${props.lots} Lot${props.lots === 1 ? '' : 's'}`;
    if (props.lotSize !== null) {
      qtyNumber.textContent = String(props.lots * props.lotSize);
      qtyLotLabel.textContent = lotWord;
    } else {
      // No lot size known — the "N Lots" count IS the primary number
      // rather than a sub-label under a guessed contract count.
      qtyNumber.textContent = lotWord;
      qtyLotLabel.textContent = '';
    }

    const disabled = props.disabled ?? false;
    qtyMinus.disabled = disabled || !props.canDecrementLots;
    qtyPlus.disabled = disabled;

    buyBtn.textContent = props.buyLabel ?? 'Buy at Mkt';
    sellBtn.textContent = props.sellLabel ?? 'Sell at Mkt';
    buyBtn.disabled = disabled || props.buyDisabledReason != null;
    sellBtn.disabled = disabled || props.sellDisabledReason != null;
    buyBtn.title = props.buyDisabledReason ?? '';
    sellBtn.title = props.sellDisabledReason ?? '';
  }

  render(initial);

  return {
    element: root,
    handleElement: handle,
    update: render,
    destroy: () => {
      qtyMinus.removeEventListener('click', onMinus);
      qtyPlus.removeEventListener('click', onPlus);
      buyBtn.removeEventListener('click', onBuy);
      sellBtn.removeEventListener('click', onSell);
    },
  };
}
