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
  private readonly changeListeners = new Set<(elementId: string, offset: Offset) => void>();
  private readonly dragEndListeners = new Set<(elementId: string, offset: Offset) => void>();

  getOffset(elementId: string): Offset {
    return this.offsets.get(elementId) ?? ZERO_OFFSET;
  }

  /** §P6t: a poll landing mid-drag must not yank the pill — callers check this before re-anchoring a dragged element to fresh server data. */
  isDragging(elementId: string): boolean {
    return this.dragStartOffsets.has(elementId);
  }

  setOffset(elementId: string, offset: Offset): void {
    this.offsets.set(elementId, offset);
    for (const cb of this.changeListeners) cb(elementId, offset);
  }

  /**
   * Multiple independent listeners (e.g. persistence AND manual-mode
   * live re-layout, §P2) can subscribe at once — this isn't a single-slot
   * callback.
   */
  onChange(cb: (elementId: string, offset: Offset) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /**
   * Fires once when a drag is COMMITTED — pointer released, or a
   * keyboard nudge (which has no separate release event, so each nudge
   * counts as its own commit). Distinct from onChange, which also fires
   * on every intermediate pointermove; §P6t's price-drag-to-server logic
   * needs "the user is done," not "the pointer moved."
   */
  onDragEnd(cb: (elementId: string, offset: Offset) => void): () => void {
    this.dragEndListeners.add(cb);
    return () => this.dragEndListeners.delete(cb);
  }

  /**
   * Wires a drag handle element to update `elementId`'s offset live during
   * drag. `lockAxis: 'x'` pins the horizontal offset at 0 — used for the
   * TP/SL pills, which ride the price axis and must only move vertically
   * when dragged on their own (dragging the group via the card's icon is
   * unrestricted; only a solo pill drag is axis-locked).
   */
  bind(elementId: string, handleElement: HTMLElement, options?: { lockAxis?: 'x' | 'y' }): void {
    const lockAxis = options?.lockAxis;
    const applyDelta = (delta: DragDelta): Offset => {
      const start = this.dragStartOffsets.get(elementId) ?? ZERO_OFFSET;
      return {
        dx: lockAxis === 'x' ? start.dx : start.dx + delta.dx,
        dy: lockAxis === 'y' ? start.dy : start.dy + delta.dy,
      };
    };

    const handle = attachDragHandle(handleElement, {
      onDragStart: () => {
        this.dragStartOffsets.set(elementId, this.getOffset(elementId));
      },
      onDragMove: (delta) => {
        this.setOffset(elementId, applyDelta(delta));
      },
      onDragEnd: (delta) => {
        const offset = applyDelta(delta);
        this.setOffset(elementId, offset);
        this.dragStartOffsets.delete(elementId);
        for (const cb of this.dragEndListeners) cb(elementId, offset);
      },
      onKeyboardNudge: (delta) => {
        const current = this.getOffset(elementId);
        const offset = {
          dx: lockAxis === 'x' ? current.dx : current.dx + delta.dx,
          dy: lockAxis === 'y' ? current.dy : current.dy + delta.dy,
        };
        this.setOffset(elementId, offset);
        for (const cb of this.dragEndListeners) cb(elementId, offset);
      },
    });
    this.handles.push(handle);
  }

  /**
   * Wires one handle (the Suggested card's icon) to move several element
   * ids together as a rigid group — "drag the group, the TP pill/SL pill/
   * card/connector line all move as one" per the on-chart reference. Each
   * id keeps its OWN offset (so a subsequent individual pill drag still
   * works normally), this just applies the same delta to all of them at
   * once during a group drag.
   *
   * Deliberately does not fire onDragEnd listeners: those drive §P6t's
   * "commit a TP/SL pointer-drag into a price change" logic, and a group
   * move is a cosmetic reposition, never a price-drag gesture.
   */
  bindGroup(handleElement: HTMLElement, elementIds: readonly string[]): void {
    const dragStarts = new Map<string, Offset>();

    const handle = attachDragHandle(handleElement, {
      onDragStart: () => {
        for (const id of elementIds) dragStarts.set(id, this.getOffset(id));
      },
      onDragMove: (delta) => {
        for (const id of elementIds) {
          const start = dragStarts.get(id) ?? ZERO_OFFSET;
          this.setOffset(id, { dx: start.dx + delta.dx, dy: start.dy + delta.dy });
        }
      },
      onDragEnd: (delta) => {
        for (const id of elementIds) {
          const start = dragStarts.get(id) ?? ZERO_OFFSET;
          this.setOffset(id, { dx: start.dx + delta.dx, dy: start.dy + delta.dy });
        }
        dragStarts.clear();
      },
      onKeyboardNudge: (delta) => {
        for (const id of elementIds) {
          const current = this.getOffset(id);
          this.setOffset(id, { dx: current.dx + delta.dx, dy: current.dy + delta.dy });
        }
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
    this.changeListeners.clear();
    this.dragEndListeners.clear();
  }
}
