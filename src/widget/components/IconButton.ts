/**
 * A real `<button>` — never a clickable `<div>` — so it's keyboard-focusable
 * and screen-reader-usable by default (§R-P3 "Trade is a real <button>").
 */

export interface IconButtonOptions {
  readonly label: string;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly onClick: () => void;
}

export interface Destroyable {
  destroy(): void;
}

export function createIconButton(
  opts: IconButtonOptions,
): { element: HTMLButtonElement } & Destroyable {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['tp-icon-btn', opts.className].filter(Boolean).join(' ');
  button.textContent = opts.label;
  button.setAttribute('aria-label', opts.ariaLabel);

  const handler = (event: MouseEvent): void => {
    event.stopPropagation();
    opts.onClick();
  };
  button.addEventListener('click', handler);

  return {
    element: button,
    destroy: () => button.removeEventListener('click', handler),
  };
}
