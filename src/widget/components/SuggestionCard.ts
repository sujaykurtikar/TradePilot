/**
 * "⚡ Suggested / <strike> CE / [Trade]" card (§P3 screenshot). The third
 * of the three independently-positionable elements (§R-P3).
 *
 * The Trade button is a real <button> (§R-P3). Clicking it does NOT
 * submit anything directly — it asks the caller to show a confirm step
 * (§P6: "Confirm step showing strike, side, lots, entry, SL, TP, and
 * risk in ₹ before anything is sent"). When `confirm` is set, this
 * component swaps its body for that confirmation view instead of the
 * normal symbol/Trade-button layout.
 */

import type { Destroyable } from './IconButton';

export interface TradeConfirmDetails {
  readonly direction: 'BUY' | 'SELL';
  readonly strikeLabel: string; // e.g. "24120 CE"
  readonly lots: number;
  readonly entryPrice: number;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly riskRupees: number | null;
  /** shown instead of the normal Confirm button while a submit is in flight (§R-P6 disable-on-submit) */
  readonly submitting?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export interface SuggestionCardProps {
  readonly symbolLabel: string; // e.g. "24120 CE"
  /** null/undefined hides the sub-line entirely (§7.1: no partial guessing) */
  readonly subLabel?: string | null;
  readonly tradeDisabled?: boolean;
  readonly tradeLabel?: string; // defaults to "Trade"
  readonly staleReason?: string | null;
  /**
   * True once a position exists for this widget (§P6t). The TP/SL pills
   * switch to tracking the position's real levels the instant this
   * happens, which can visibly differ from the last-shown suggestion —
   * the card must say so plainly ("Position", not "Suggested") rather
   * than silently keep the old label, which reads as an unexplained
   * glitch when the pills jump.
   */
  readonly hasPosition?: boolean;
  readonly onTrade: () => void;
  /** §P6: freeze the suggestion on hover/focus of Trade — levels must not shift mid-decision. */
  readonly onTradeFocusChange?: (focused: boolean) => void;
  /** Non-null switches the card into the confirmation view (§P6). */
  readonly confirm?: TradeConfirmDetails | null;
}

export interface SuggestionCardComponent extends Destroyable {
  readonly element: HTMLDivElement;
  readonly handleElement: HTMLElement;
  update(props: SuggestionCardProps): void;
}

function formatRupees(value: number): string {
  return `₹${Math.round(Math.abs(value)).toLocaleString('en-IN')}`;
}

export function createSuggestionCard(initial: SuggestionCardProps): SuggestionCardComponent {
  const root = document.createElement('div');
  root.className = 'tp-card';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Suggested trade');

  const handle = document.createElement('span');
  handle.className = 'tp-card__icon';
  handle.textContent = '⇄';
  handle.setAttribute('aria-hidden', 'true');

  // ---- normal (strategy-mode) view ----
  const body = document.createElement('div');
  body.className = 'tp-card__body';

  const textCol = document.createElement('div');
  textCol.className = 'tp-card__text';

  const title = document.createElement('div');
  title.className = 'tp-card__title';
  title.textContent = 'Suggested';

  const symbol = document.createElement('div');
  symbol.className = 'tp-card__symbol';
  const sub = document.createElement('div');
  sub.className = 'tp-card__symbol-sub';
  textCol.append(title, symbol, sub);

  const tradeBtn = document.createElement('button');
  tradeBtn.type = 'button';
  tradeBtn.className = 'tp-card__trade-btn';

  body.append(handle, textCol, tradeBtn);

  // ---- confirm view (§P6) ----
  const confirmView = document.createElement('div');
  confirmView.className = 'tp-card__confirm';
  confirmView.style.display = 'none';

  const confirmSummary = document.createElement('div');
  confirmSummary.className = 'tp-card__confirm-summary';

  const confirmActions = document.createElement('div');
  confirmActions.className = 'tp-card__confirm-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'tp-card__trade-btn';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tp-icon-btn tp-card__cancel-btn';
  cancelBtn.textContent = 'Cancel';

  confirmActions.append(cancelBtn, confirmBtn);
  confirmView.append(confirmSummary, confirmActions);

  root.append(body, confirmView);

  let currentProps: SuggestionCardProps = initial;

  const onTradeClick = (): void => {
    if (tradeBtn.disabled) return;
    currentProps.onTrade();
  };
  const onFocus = (): void => currentProps.onTradeFocusChange?.(true);
  const onBlur = (): void => currentProps.onTradeFocusChange?.(false);
  const onMouseEnter = (): void => currentProps.onTradeFocusChange?.(true);
  const onMouseLeave = (): void => currentProps.onTradeFocusChange?.(false);
  const onConfirmClick = (): void => {
    if (confirmBtn.disabled) return;
    currentProps.confirm?.onConfirm();
  };
  const onCancelClick = (): void => {
    if (cancelBtn.disabled) return;
    currentProps.confirm?.onCancel();
  };

  tradeBtn.addEventListener('click', onTradeClick);
  tradeBtn.addEventListener('focus', onFocus);
  tradeBtn.addEventListener('blur', onBlur);
  tradeBtn.addEventListener('mouseenter', onMouseEnter);
  tradeBtn.addEventListener('mouseleave', onMouseLeave);
  confirmBtn.addEventListener('click', onConfirmClick);
  cancelBtn.addEventListener('click', onCancelClick);

  function renderConfirm(confirm: TradeConfirmDetails): void {
    body.style.display = 'none';
    confirmView.style.display = '';

    const lines = [
      `${confirm.direction} ${confirm.lots}× ${confirm.strikeLabel}`,
      `Entry ${confirm.entryPrice.toFixed(2)}`,
      confirm.sl !== null ? `SL ${confirm.sl.toFixed(2)}` : 'SL —',
      confirm.tp !== null ? `TP ${confirm.tp.toFixed(2)}` : 'TP —',
      confirm.riskRupees !== null ? `Risk ${formatRupees(confirm.riskRupees)}` : 'Risk —',
    ];
    confirmSummary.textContent = lines.join(' · ');
    confirmSummary.setAttribute('aria-label', `Confirm trade: ${lines.join(', ')}`);

    const submitting = confirm.submitting ?? false;
    confirmBtn.textContent = submitting ? 'Placing…' : 'Confirm';
    confirmBtn.disabled = submitting;
    cancelBtn.disabled = submitting;
  }

  function render(props: SuggestionCardProps): void {
    currentProps = props;

    if (props.confirm) {
      renderConfirm(props.confirm);
      return;
    }
    body.style.display = '';
    confirmView.style.display = 'none';

    root.setAttribute('aria-label', props.hasPosition ? 'Open position' : 'Suggested trade');

    title.textContent = props.hasPosition ? 'Position' : 'Suggested';
    symbol.textContent = props.symbolLabel;
    // Kept out of the compact card on purpose — it stays just icon /
    // "Suggested" / strike / Trade button, with no extra LTP line eating
    // chart space (§ user request).
    sub.style.display = 'none';

    if (props.staleReason) {
      tradeBtn.textContent = props.staleReason;
      tradeBtn.disabled = true;
      tradeBtn.classList.add('tp-card__stale');
    } else {
      tradeBtn.textContent = props.tradeLabel ?? 'Trade';
      tradeBtn.disabled = props.tradeDisabled ?? false;
      tradeBtn.classList.remove('tp-card__stale');
    }
  }

  render(initial);

  return {
    element: root,
    handleElement: handle,
    update: render,
    destroy: () => {
      tradeBtn.removeEventListener('click', onTradeClick);
      tradeBtn.removeEventListener('focus', onFocus);
      tradeBtn.removeEventListener('blur', onBlur);
      tradeBtn.removeEventListener('mouseenter', onMouseEnter);
      tradeBtn.removeEventListener('mouseleave', onMouseLeave);
      confirmBtn.removeEventListener('click', onConfirmClick);
      cancelBtn.removeEventListener('click', onCancelClick);
    },
  };
}
