/**
 * TP/SL pill (§P3 screenshot: "⠿ TP 24126.2 ×"). One of the three
 * independently-positionable elements (§R-P3) — AnchorManager sets its
 * transform every frame; this component only renders content.
 */

import { formatPrice } from '../../utils/dom';
import { createIconButton } from './IconButton';
import type { Destroyable } from './IconButton';

export type LevelPillVariant = 'tp' | 'sl';

export interface LevelPillProps {
  readonly variant: LevelPillVariant;
  readonly price: number | null;
  /** §P6t: a locally-dragged-but-unconfirmed level renders visually distinct. */
  readonly pending?: boolean;
  readonly onClose?: () => void;
}

export interface LevelPillComponent extends Destroyable {
  readonly element: HTMLDivElement;
  readonly handleElement: HTMLElement;
  update(props: LevelPillProps): void;
}

export function createLevelPill(initial: LevelPillProps): LevelPillComponent {
  const root = document.createElement('div');
  root.setAttribute('role', 'group');

  const handle = document.createElement('span');
  handle.className = 'tp-pill__handle';
  handle.textContent = '⠿'; // ⠿
  handle.setAttribute('aria-hidden', 'false');

  const label = document.createElement('span');
  label.className = 'tp-pill__label';

  const value = document.createElement('span');
  value.className = 'tp-pill__value';

  root.append(handle, label, value);

  let closeBtn: ReturnType<typeof createIconButton> | null = null;

  function render(props: LevelPillProps): void {
    // Toggle only the visual state classes here — `root` also carries
    // externally-managed classes (tp-positioned, tp-mount-animate) that
    // AnchorManager's positioning relies on; overwriting className wholesale
    // would silently strip those and break the pill's anchoring.
    root.classList.add('tp-pill');
    root.classList.toggle('tp-pill--tp', props.variant === 'tp');
    root.classList.toggle('tp-pill--sl', props.variant === 'sl');
    root.classList.toggle('tp-pill--pending', props.pending === true);
    label.textContent = props.variant.toUpperCase();
    value.textContent = props.price === null ? '—' : formatPrice(props.price);
    root.setAttribute(
      'aria-label',
      `${props.variant.toUpperCase()} level ${props.price === null ? 'unavailable' : formatPrice(props.price)}`,
    );

    closeBtn?.destroy();
    closeBtn?.element.remove();
    closeBtn = null;
    if (props.onClose) {
      closeBtn = createIconButton({
        label: '×',
        ariaLabel: `Dismiss ${props.variant.toUpperCase()} pill`,
        onClick: props.onClose,
      });
      root.appendChild(closeBtn.element);
    }
  }

  render(initial);

  return {
    element: root,
    handleElement: handle,
    update: render,
    destroy: () => {
      closeBtn?.destroy();
    },
  };
}
