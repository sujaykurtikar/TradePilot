/**
 * "⚡ Suggested / <strike> CE / [Trade]" card (§P3 screenshot). The third
 * of the three independently-positionable elements (§R-P3).
 *
 * The Trade button here is a real <button> (§R-P3) whose click handler is
 * supplied by the caller — Day-1 wires it to a confirm-toast stub (§6.0);
 * P6 replaces that with the real order flow, this component doesn't
 * change.
 */

import type { Destroyable } from './IconButton';

export interface SuggestionCardProps {
  readonly symbolLabel: string; // e.g. "24120 CE"
  /** null/undefined hides the sub-line entirely (§7.1: no partial guessing) */
  readonly subLabel?: string | null;
  readonly tradeDisabled?: boolean;
  readonly tradeLabel?: string; // defaults to "Trade"
  readonly staleReason?: string | null;
  readonly onTrade: () => void;
  /** §P6: freeze the suggestion on hover/focus of Trade — levels must not shift mid-decision. */
  readonly onTradeFocusChange?: (focused: boolean) => void;
}

export interface SuggestionCardComponent extends Destroyable {
  readonly element: HTMLDivElement;
  readonly handleElement: HTMLElement;
  update(props: SuggestionCardProps): void;
}

export function createSuggestionCard(initial: SuggestionCardProps): SuggestionCardComponent {
  const root = document.createElement('div');
  root.className = 'tp-card';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Suggested trade');

  const header = document.createElement('div');
  header.className = 'tp-card__header';

  const handle = document.createElement('span');
  handle.className = 'tp-pill__handle';
  handle.textContent = '⠿';

  const title = document.createElement('span');
  title.className = 'tp-card__title';
  title.textContent = '⚡ Suggested';

  header.append(handle, title);

  const body = document.createElement('div');
  body.className = 'tp-card__body';

  const symbolWrap = document.createElement('div');
  const symbol = document.createElement('div');
  symbol.className = 'tp-card__symbol';
  const sub = document.createElement('div');
  sub.className = 'tp-card__symbol-sub';
  symbolWrap.append(symbol, sub);

  const tradeBtn = document.createElement('button');
  tradeBtn.type = 'button';
  tradeBtn.className = 'tp-card__trade-btn';

  body.append(symbolWrap, tradeBtn);
  root.append(header, body);

  let currentProps: SuggestionCardProps = initial;

  const onClick = (): void => {
    if (tradeBtn.disabled) return;
    currentProps.onTrade();
  };
  const onFocus = (): void => currentProps.onTradeFocusChange?.(true);
  const onBlur = (): void => currentProps.onTradeFocusChange?.(false);
  const onMouseEnter = (): void => currentProps.onTradeFocusChange?.(true);
  const onMouseLeave = (): void => currentProps.onTradeFocusChange?.(false);

  tradeBtn.addEventListener('click', onClick);
  tradeBtn.addEventListener('focus', onFocus);
  tradeBtn.addEventListener('blur', onBlur);
  tradeBtn.addEventListener('mouseenter', onMouseEnter);
  tradeBtn.addEventListener('mouseleave', onMouseLeave);

  function render(props: SuggestionCardProps): void {
    currentProps = props;
    symbol.textContent = props.symbolLabel;
    sub.textContent = props.subLabel ?? '';
    sub.style.display = props.subLabel ? '' : 'none';

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
      tradeBtn.removeEventListener('click', onClick);
      tradeBtn.removeEventListener('focus', onFocus);
      tradeBtn.removeEventListener('blur', onBlur);
      tradeBtn.removeEventListener('mouseenter', onMouseEnter);
      tradeBtn.removeEventListener('mouseleave', onMouseLeave);
    },
  };
}
