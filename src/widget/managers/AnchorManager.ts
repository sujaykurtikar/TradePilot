/**
 * The single rAF loop that anchors every widget element to the chart
 * (IMPLEMENTATION_PLAN.md §P4/§R-P4a). Exactly one instance may run per
 * content script — "One rAF loop. A second one is a defect" — enforced
 * here by refusing to start a second internal loop if one is already
 * running.
 *
 * Per target per frame:
 *   y = bridge.priceToY(price)
 *   x = pinRight ? paneRect.right - GUTTER : bridge.timeToX(time)
 *   null (either) -> hide, never extrapolate/guess (§7.1)
 *   sub-pixel delta -> skip the DOM write entirely (idle CPU ≈ 0%)
 *   else -> transform: translate3d(x, y, 0), the only positioning
 *           mechanism allowed (§R-P3 — top/left forces host layout)
 *
 * A DragManager offset is added on top of the anchor-computed base
 * position — see DragManager.ts's header for why (dragging shifts a pill
 * without detaching it from the price it represents).
 */

import type { ChartBridge } from '../../bridge/ChartBridge';
import { nearlyEqual } from '../../utils/dom';
import type { DragManager } from './DragManager';
import { getLogger } from '../../utils/logger';

const log = getLogger('widget:anchor-manager');

const RIGHT_GUTTER_PX = 12;

export interface AnchorTarget {
  readonly id: string;
  readonly element: HTMLElement;
  /** null return -> hide this frame. Called every frame; keep it cheap. */
  getPrice: () => number | null;
  /**
   * If provided, X is computed via `bridge.timeToX(getTime())`. If
   * omitted (or returns null) and `pinRight` is true, X pins to the
   * pane's right edge instead — used by the Suggested card, which rides
   * the live price at the chart's edge rather than a fixed historical bar.
   */
  getTime?: () => number | null;
  readonly pinRight?: boolean;
  /**
   * Use this OTHER target's horizontal offset instead of this target's own
   * — the TP/SL pills use it to always mirror the Suggested card's dx.
   * Solo TP/SL drags are vertical-only (DragManager's lockAxis), so a
   * pill's own dx should never legitimately differ from the card's; this
   * makes that true unconditionally, self-healing any stray per-pill
   * horizontal offset already sitting in chrome.storage from before that
   * lock existed, rather than requiring a one-off storage migration.
   */
  readonly mirrorOffsetXFrom?: string;
}

interface LastApplied {
  x: number;
  y: number;
  visible: boolean;
}

export type PaneRectOrNull = ReturnType<ChartBridge['paneRect']>;

export class AnchorManager {
  private readonly bridge: ChartBridge;
  private readonly dragManager: DragManager;
  private readonly targets = new Map<string, AnchorTarget>();
  private readonly lastApplied = new Map<string, LastApplied>();
  private readonly frameListeners = new Set<(paneRect: PaneRectOrNull) => void>();
  private rafHandle: number | null = null;
  private disposed = false;

  constructor(bridge: ChartBridge, dragManager: DragManager) {
    this.bridge = bridge;
    this.dragManager = dragManager;
  }

  addTarget(target: AnchorTarget): void {
    this.targets.set(target.id, target);
  }

  removeTarget(id: string): void {
    this.targets.delete(id);
    this.lastApplied.delete(id);
  }

  /** Subscribe to the per-frame paneRect, for elements (e.g. the connector line) that derive their own position instead of registering as an AnchorTarget. Returns an unsubscribe function. */
  onFrame(listener: (paneRect: PaneRectOrNull) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  start(): void {
    if (this.rafHandle !== null || this.disposed) return; // one loop, idempotent start
    const tick = (): void => {
      if (this.disposed) return;
      this.runFrame();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private runFrame(): void {
    // Guard against a torn-down chart / disposed bridge — a fault here
    // must never throw into the frame loop (§5.4/§7.4).
    let paneRect;
    try {
      paneRect = this.bridge.paneRect();
    } catch (error) {
      log.debug('paneRect() threw mid-frame — skipping this frame', { error: String(error) });
      return;
    }

    for (const target of this.targets.values()) {
      this.applyTarget(target, paneRect);
    }

    for (const listener of this.frameListeners) {
      listener(paneRect);
    }
  }

  private applyTarget(target: AnchorTarget, paneRect: ReturnType<ChartBridge['paneRect']>): void {
    let price: number | null;
    try {
      price = target.getPrice();
    } catch (error) {
      log.debug('getPrice() threw for target', { id: target.id, error: String(error) });
      price = null;
    }

    const priceValue = price;
    const y = priceValue === null ? null : safeBridgeCall(() => this.bridge.priceToY(priceValue));

    let x: number | null = null;
    if (y !== null) {
      const time = target.getTime?.() ?? null;
      if (time !== null) {
        x = safeBridgeCall(() => this.bridge.timeToX(time));
      } else if (target.pinRight && paneRect !== null) {
        x = paneRect.right - RIGHT_GUTTER_PX;
      }
    }

    if (x === null || y === null) {
      this.hide(target);
      return;
    }

    const offset = this.dragManager.getOffset(target.id);
    const dx =
      target.mirrorOffsetXFrom !== undefined
        ? this.dragManager.getOffset(target.mirrorOffsetXFrom).dx
        : offset.dx;
    const finalX = x + dx;
    const finalY = y + offset.dy;

    const last = this.lastApplied.get(target.id);
    if (
      last !== undefined &&
      last.visible &&
      nearlyEqual(finalX, last.x) &&
      nearlyEqual(finalY, last.y)
    ) {
      return; // sub-pixel — skip the DOM write (§R-P4a performance budget)
    }

    target.element.classList.remove('tp-positioned--hidden');
    target.element.style.transform = `translate3d(${finalX}px, ${finalY}px, 0)`;
    this.lastApplied.set(target.id, { x: finalX, y: finalY, visible: true });
  }

  private hide(target: AnchorTarget): void {
    const last = this.lastApplied.get(target.id);
    if (last !== undefined && !last.visible) return; // already hidden, skip DOM write
    target.element.classList.add('tp-positioned--hidden');
    this.lastApplied.set(target.id, { x: 0, y: 0, visible: false });
  }

  /** Full teardown (§R-P4a/§7.5) — stops the loop and drops all target refs. */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.targets.clear();
    this.lastApplied.clear();
    this.frameListeners.clear();
  }
}

function safeBridgeCall(fn: () => number | null): number | null {
  try {
    const value = fn();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch (error) {
    log.debug('bridge coordinate call threw', { error: String(error) });
    return null;
  }
}
