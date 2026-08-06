/**
 * Low-level pointer-drag primitive (§P3/§R-P3). Reused by both:
 *  - P3's widget-position dragging (moving a pill/card's screen offset), and
 *  - P6t's post-trade price dragging (dragging a confirmed SL/TP to a new
 *    price) — same mechanics, different release-time behavior wired by
 *    the caller via `onDragEnd`.
 *
 * §R-P3 requirements encoded here:
 *  - pointer capture, not mouse events — works for touch/pen too.
 *  - `touch-action: none` is set in CSS on `.tp-pill__handle`; this file
 *    just wires the JS side.
 *  - arrow-key nudge as a keyboard alternative to dragging, since a
 *    pointer-only drag interaction excludes keyboard users.
 */

import type { Destroyable } from './IconButton';

export interface DragDelta {
  readonly dx: number;
  readonly dy: number;
}

export interface DragHandleCallbacks {
  onDragStart?: () => void;
  onDragMove: (delta: DragDelta) => void;
  onDragEnd?: (delta: DragDelta) => void;
  /** Arrow-key nudge — same delta shape, one keypress = one step. */
  onKeyboardNudge?: (delta: DragDelta) => void;
}

const KEY_NUDGE_PX = 4;

export function attachDragHandle(
  element: HTMLElement,
  callbacks: DragHandleCallbacks,
): Destroyable {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let activePointerId: number | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    activePointerId = event.pointerId;
    element.setPointerCapture(event.pointerId);
    callbacks.onDragStart?.();
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== activePointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    callbacks.onDragMove({ dx, dy });
  };

  const endDrag = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== activePointerId) return;
    dragging = false;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    activePointerId = null;
    callbacks.onDragEnd?.({ dx, dy });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (callbacks.onKeyboardNudge === undefined) return;
    const map: Record<string, DragDelta> = {
      ArrowUp: { dx: 0, dy: -KEY_NUDGE_PX },
      ArrowDown: { dx: 0, dy: KEY_NUDGE_PX },
      ArrowLeft: { dx: -KEY_NUDGE_PX, dy: 0 },
      ArrowRight: { dx: KEY_NUDGE_PX, dy: 0 },
    };
    const delta = map[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    callbacks.onKeyboardNudge(delta);
  };

  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', 'Drag to reposition');
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);
  element.addEventListener('keydown', onKeyDown);

  return {
    destroy: () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', endDrag);
      element.removeEventListener('pointercancel', endDrag);
      element.removeEventListener('keydown', onKeyDown);
    },
  };
}
