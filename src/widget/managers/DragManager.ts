/**
 * Tracks a persistent screen-space offset per widget element (§P3: "drag
 * the widget's own screen position"). The offset is added on top of
 * AnchorManager's price-computed base position each frame, so a dragged
 * pill still tracks its price — just shifted by however far the user
 * nudged it — rather than detaching from the chart entirely. "Stays where
 * dropped" (§6.0) is satisfied because the offset persists after drag end.
 *
 * Day-1 scope: offsets live in memory only. Persisting them across page
 * reloads (chrome.storage) is wired by content/Bootstrap.ts once
 * core/storage exists — this class just exposes an onChange hook for that.
 */

import { attachDragHandle, type DragDelta } from '../components/DragHandle';
import type { Destroyable } from '../components/IconButton';

export interface Offset {
  readonly dx: number;
  readonly dy: number;
}

const ZERO_OFFSET: Offset = { dx: 0, dy: 0 };

export class DragManager {
  private readonly offsets = new Map<string, Offset>();
  private readonly dragStartOffsets = new Map<string, Offset>();
  private readonly handles: Destroyable[] = [];
  private onChangeCb: ((elementId: string, offset: Offset) => void) | null = null;

  getOffset(elementId: string): Offset {
    return this.offsets.get(elementId) ?? ZERO_OFFSET;
  }

  setOffset(elementId: string, offset: Offset): void {
    this.offsets.set(elementId, offset);
    this.onChangeCb?.(elementId, offset);
  }

  onChange(cb: (elementId: string, offset: Offset) => void): void {
    this.onChangeCb = cb;
  }

  /** Wires a drag handle element to update `elementId`'s offset live during drag. */
  bind(elementId: string, handleElement: HTMLElement): void {
    const applyDelta = (delta: DragDelta): Offset => {
      const start = this.dragStartOffsets.get(elementId) ?? ZERO_OFFSET;
      return { dx: start.dx + delta.dx, dy: start.dy + delta.dy };
    };

    const handle = attachDragHandle(handleElement, {
      onDragStart: () => {
        this.dragStartOffsets.set(elementId, this.getOffset(elementId));
      },
      onDragMove: (delta) => {
        this.setOffset(elementId, applyDelta(delta));
      },
      onDragEnd: (delta) => {
        this.setOffset(elementId, applyDelta(delta));
        this.dragStartOffsets.delete(elementId);
      },
      onKeyboardNudge: (delta) => {
        const current = this.getOffset(elementId);
        this.setOffset(elementId, { dx: current.dx + delta.dx, dy: current.dy + delta.dy });
      },
    });
    this.handles.push(handle);
  }

  /** Restores a persisted offset (e.g. loaded from chrome.storage) without triggering onChange. */
  hydrate(elementId: string, offset: Offset): void {
    this.offsets.set(elementId, offset);
  }

  /**
   * Clears all offsets back to zero (popup's "reset position", §P1). Does
   * NOT invoke onChange — the caller (WidgetRoot.resetOffsets, driven by
   * an external chrome.storage change from the popup) already knows
   * storage was reset by whoever triggered this, so re-announcing it back
   * out would just be a redundant write.
   */
  resetAll(): void {
    this.offsets.clear();
    this.dragStartOffsets.clear();
  }

  destroy(): void {
    for (const handle of this.handles) handle.destroy();
    this.handles.length = 0;
    this.offsets.clear();
    this.dragStartOffsets.clear();
  }
}
