import { describe, it, expect, vi } from 'vitest';
import { DragManager } from '../src/widget/managers/DragManager';

describe('DragManager', () => {
  it('returns a zero offset for an unknown element', () => {
    const dm = new DragManager();
    expect(dm.getOffset('nope')).toEqual({ dx: 0, dy: 0 });
  });

  it('setOffset stores the value and getOffset returns it', () => {
    const dm = new DragManager();
    dm.setOffset('tp', { dx: 10, dy: -4 });
    expect(dm.getOffset('tp')).toEqual({ dx: 10, dy: -4 });
  });

  it('setOffset fires the onChange callback with id and offset', () => {
    const dm = new DragManager();
    const cb = vi.fn();
    dm.onChange(cb);
    dm.setOffset('sl', { dx: 1, dy: 2 });
    expect(cb).toHaveBeenCalledWith('sl', { dx: 1, dy: 2 });
  });

  it('hydrate restores a persisted offset WITHOUT firing onChange (§P1 — must not write straight back to storage)', () => {
    const dm = new DragManager();
    const cb = vi.fn();
    dm.onChange(cb);
    dm.hydrate('tp', { dx: 3, dy: 3 });
    expect(dm.getOffset('tp')).toEqual({ dx: 3, dy: 3 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('resetAll clears every offset back to zero', () => {
    const dm = new DragManager();
    dm.setOffset('tp', { dx: 5, dy: 5 });
    dm.setOffset('sl', { dx: 7, dy: 7 });
    dm.resetAll();
    expect(dm.getOffset('tp')).toEqual({ dx: 0, dy: 0 });
    expect(dm.getOffset('sl')).toEqual({ dx: 0, dy: 0 });
  });

  it('bind() attaches a working drag handle that accumulates pointer deltas into the offset', () => {
    const dm = new DragManager();
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    dm.bind('card', handle);

    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 }),
    );
    handle.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 130, clientY: 90 }),
    );
    expect(dm.getOffset('card')).toEqual({ dx: 30, dy: -10 });

    handle.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 1, clientX: 140, clientY: 80 }),
    );
    expect(dm.getOffset('card')).toEqual({ dx: 40, dy: -20 });

    // A second drag accumulates ON TOP of the first — "stays where dropped" (§6.0).
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 2, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 5, clientY: 5 }));
    expect(dm.getOffset('card')).toEqual({ dx: 45, dy: -15 });

    dm.destroy();
    handle.remove();
  });

  it('arrow-key nudge moves the offset by the fixed step', () => {
    const dm = new DragManager();
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    dm.bind('pill', handle);

    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(dm.getOffset('pill')).toEqual({ dx: 4, dy: 0 });
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(dm.getOffset('pill')).toEqual({ dx: 4, dy: -4 });

    dm.destroy();
    handle.remove();
  });
});
