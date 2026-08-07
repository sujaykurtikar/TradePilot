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

/**
 * How much room an element needs inside the pane edge to count as "on the
 * chart". Elements are centred on their anchor point (`translate: -50%
 * -50%` in widget.css), so this is roughly half a pill's height — below it
 * the pill would straddle the edge and spill onto the host's toolbar or
 * time axis.
 */
const PANE_EDGE_INSET_PX = 18;

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
  /**
   * What to do when this element's price scrolls or zooms past the visible
   * axis:
   *
   *  - 'hide': stay glued to the real price and go off-screen with it,
   *    exactly like a candle would — the TP/SL pills. A level only moves
   *    relative to price when the user drags its own handle; it must never
   *    appear to move because the chart was rescaled.
   *  - 'pin': stay visible, pinned just inside the nearest pane edge with
   *    the label still reading its real price. Nothing currently uses
   *    this, kept for a level that should never disappear regardless of
   *    zoom.
   *  - omitted: unconstrained, for an element whose price is on-screen by
   *    definition (the Suggested card, which rides the live price).
   *
   * Both directions of "can't place this" — a bridge that extrapolates a Y
   * past the axis, and one that returns null for it — are treated
   * identically here, so the top and bottom edges of the chart always
   * behave the same way regardless of which one the bridge happens to do.
   */
  readonly offPaneBehavior?: 'hide' | 'pin';
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
  /** Per target, the Y a connector line should meet it at this frame — see connectorAnchorY. */
  private readonly connectorAnchors = new Map<string, number | null>();
  /** Per target, the Y it was actually drawn at this frame, or null if hidden — see drawnY. */
  private readonly drawnAnchors = new Map<string, number | null>();
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
    this.connectorAnchors.delete(id);
    this.drawnAnchors.delete(id);
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

  /**
   * The one place a price becomes a viewport Y. Public so the connector
   * line — which derives its own geometry rather than being an AnchorTarget
   * — stays pixel-consistent with the pills it joins, instead of
   * re-implementing this and drifting.
   *
   * `offPaneBehavior` omitted returns the bridge's raw answer even when
   * it's outside the pane (extrapolated) — the connector line wants that
   * raw value so it can clip itself to the pane edge independently; see
   * WidgetRoot.applyConnectorLine.
   */
  resolveY(
    price: number,
    paneRect: PaneRectOrNull,
    offPaneBehavior?: 'hide' | 'pin',
  ): number | null {
    const direct = safeBridgeCall(() => this.bridge.priceToY(price));
    if (direct !== null) {
      if (offPaneBehavior === undefined || isInsidePane(direct, paneRect)) return direct;
      return offPaneBehavior === 'hide' ? null : clampIntoPaneOrNull(direct, paneRect);
    }
    // priceToY refused outright — only 'pin' has anything to fall back on.
    return offPaneBehavior === 'pin' ? this.pinPriceToPaneEdge(price, paneRect) : null;
  }

  /** Confines an already-positioned Y (anchor + drag offset) to the pane. Public so a committed drag converts back through the same bound the pill was drawn under, instead of reading a price off a Y the user was never shown. */
  clampYToPane(y: number, paneRect: PaneRectOrNull): number {
    return paneRect === null ? y : clampIntoPane(y, paneRect);
  }

  /**
   * Where a connector line should attach for a target: the exact Y that
   * target was drawn at, or — if it wasn't drawn — the pane edge its price
   * lies beyond.
   *
   * The line and the pill used to resolve their positions independently
   * from the same price, and could disagree: the pill applies a half-height
   * inset so it can't straddle the pane boundary, the line has no height
   * and applies none, and the bridge returns null for an off-pane price
   * rather than a coordinate outside the pane
   * (TradingViewInternalApiBridge, §R-P4a "never extrapolate") — which left
   * the line with nothing to reach for exactly when it mattered. Reading
   * the position the pill actually got makes those disagreements
   * impossible rather than merely fixed.
   *
   * No PANE_EDGE_INSET_PX in the off-pane case: a line has no height of its
   * own to keep clear of the boundary, and insetting it would leave a gap
   * at the very edge it's meant to run off.
   *
   * Only meaningful after the frame's applyTarget pass, which is why
   * frame listeners run last in runFrame().
   */
  connectorAnchorY(id: string): number | null {
    return this.connectorAnchors.get(id) ?? null;
  }

  /**
   * The Y a target was actually drawn at this frame, or null if it's
   * currently hidden (off-pane, or no price). Unlike connectorAnchorY, this
   * never falls back to a pane-edge guess — a full-width price line has no
   * pill to point at once its level goes off-screen, so it should simply
   * disappear along with it rather than run to an edge.
   */
  drawnY(id: string): number | null {
    return this.drawnAnchors.get(id) ?? null;
  }

  /**
   * The edge to attach a line to for a target that isn't drawn: the one its
   * price is beyond, or — when the price is on the axis but the element was
   * still held back (too close to the boundary to sit fully inside) — the
   * nearer edge, so the line reads as running off the chart rather than
   * stopping at a bare point with no pill on it.
   */
  private offPaneAnchor(
    price: number,
    rawY: number | null,
    paneRect: PaneRectOrNull,
  ): number | null {
    const byPrice = this.priceEdgeY(price, paneRect);
    if (byPrice !== null) return byPrice;
    if (rawY === null || paneRect === null) return null;
    return rawY < (paneRect.y + paneRect.bottom) / 2 ? paneRect.y : paneRect.bottom;
  }

  /**
   * Which pane edge an unplaceable price belongs against, and the Y just
   * inside it — the pills' variant of connectorY, kept clear of the
   * boundary by the element's own half-height.
   */
  private pinPriceToPaneEdge(price: number, paneRect: PaneRectOrNull): number | null {
    const edgeY = this.priceEdgeY(price, paneRect);
    return edgeY === null ? null : clampIntoPaneOrNull(edgeY, paneRect);
  }

  /**
   * The pane edge an off-scale price lies beyond. Reads the direction of
   * the price axis off its two sampled edges rather than assuming higher
   * price == smaller Y, so an inverted scale can't silently send TP and SL
   * to the wrong ends.
   */
  private priceEdgeY(price: number, paneRect: PaneRectOrNull): number | null {
    if (paneRect === null) return null;
    const topPrice = safeBridgeCall(() => this.bridge.yToPrice(paneRect.y));
    const bottomPrice = safeBridgeCall(() => this.bridge.yToPrice(paneRect.bottom));
    if (topPrice === null || bottomPrice === null || topPrice === bottomPrice) return null;

    const topIsHigherPrice = topPrice > bottomPrice;
    const highPrice = topIsHigherPrice ? topPrice : bottomPrice;
    const lowPrice = topIsHigherPrice ? bottomPrice : topPrice;

    if (price > highPrice) return topIsHigherPrice ? paneRect.y : paneRect.bottom;
    if (price < lowPrice) return topIsHigherPrice ? paneRect.bottom : paneRect.y;
    // In range, yet priceToY still couldn't place it — a genuine unknown,
    // not an off-screen level. §7.1: hide rather than invent.
    return null;
  }

  /**
   * The part of a vertical segment between two Ys that falls inside the
   * pane, or null if none of it does. Lets the connector line stay pinned
   * to the real TP/SL prices and simply run off the edge of the chart,
   * rather than either vanishing wholesale or being redrawn between
   * substitute endpoints.
   */
  clipSegmentToPane(
    yA: number,
    yB: number,
    paneRect: PaneRectOrNull,
  ): { readonly top: number; readonly height: number } | null {
    const top = Math.min(yA, yB);
    const bottom = Math.max(yA, yB);
    if (paneRect === null) return { top, height: bottom - top };
    const visibleTop = Math.max(top, paneRect.y);
    const visibleBottom = Math.min(bottom, paneRect.bottom);
    if (visibleBottom <= visibleTop) return null;
    return { top: visibleTop, height: visibleBottom - visibleTop };
  }

  private applyTarget(target: AnchorTarget, paneRect: ReturnType<ChartBridge['paneRect']>): void {
    let price: number | null;
    try {
      price = target.getPrice();
    } catch (error) {
      log.debug('getPrice() threw for target', { id: target.id, error: String(error) });
      price = null;
    }

    const offset = this.dragManager.getOffset(target.id);
    // The bridge's own coordinate for this price, before any on-pane rule.
    // Null means it could not place it — which, for a price scrolled or
    // zoomed off the axis, is exactly what it reports (§R-P4a: it never
    // extrapolates a coordinate outside the pane).
    const anchorY = price === null ? null : this.resolveY(price, paneRect);
    const rawY = anchorY === null ? null : anchorY + offset.dy;

    let drawY: number | null = rawY;
    if (target.offPaneBehavior === 'hide') {
      // A drag offset (including a stale one restored from storage, before
      // that was stopped) can carry an on-screen element back off the pane,
      // so this is applied AFTER the offset — one rule for "is this on the
      // chart", not two.
      if (rawY === null || !isInsidePane(rawY, paneRect)) drawY = null;
    } else if (target.offPaneBehavior === 'pin' && price !== null) {
      drawY =
        rawY === null
          ? this.pinPriceToPaneEdge(price, paneRect)
          : clampIntoPaneOrNull(rawY, paneRect);
    }

    let x: number | null = null;
    if (drawY !== null) {
      const time = target.getTime?.() ?? null;
      if (time !== null) {
        x = safeBridgeCall(() => this.bridge.timeToX(time));
      } else if (target.pinRight && paneRect !== null) {
        x = paneRect.right - RIGHT_GUTTER_PX;
      }
    }

    const drawn = x !== null && drawY !== null;
    // Single source of truth for the connector line (see connectorAnchorY).
    // Recorded for every target every frame, drawn or not, and BEFORE any
    // early return, so the line can never be left reasoning from a
    // different frame's numbers than the pill it joins.
    this.connectorAnchors.set(
      target.id,
      drawn ? drawY : price === null ? null : this.offPaneAnchor(price, rawY, paneRect),
    );
    this.drawnAnchors.set(target.id, drawn ? drawY : null);

    if (!drawn || x === null || drawY === null) {
      this.hide(target);
      return;
    }

    const dx =
      target.mirrorOffsetXFrom !== undefined
        ? this.dragManager.getOffset(target.mirrorOffsetXFrom).dx
        : offset.dx;
    const finalX = x + dx;
    const finalY = drawY;

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
    this.connectorAnchors.clear();
    this.drawnAnchors.clear();
    this.frameListeners.clear();
  }
}

/**
 * Confines a Y to the pane, leaving PANE_EDGE_INSET_PX of room so a
 * centre-anchored element sits fully inside rather than straddling the
 * edge. A pane too short to hold that inset (a collapsed/hidden chart)
 * falls back to its centre — still inside, which is the whole point.
 */
function clampIntoPane(y: number, paneRect: NonNullable<PaneRectOrNull>): number {
  const top = paneRect.y + PANE_EDGE_INSET_PX;
  const bottom = paneRect.bottom - PANE_EDGE_INSET_PX;
  if (bottom <= top) return (paneRect.y + paneRect.bottom) / 2;
  return Math.min(Math.max(y, top), bottom);
}

function clampIntoPaneOrNull(y: number, paneRect: PaneRectOrNull): number | null {
  return paneRect === null ? null : clampIntoPane(y, paneRect);
}

/**
 * Whether a centre-anchored element at this Y sits fully on the chart. An
 * unknown pane can't answer that, so it reports false — the same "hide
 * rather than draw somewhere unverified" default as everywhere else here.
 */
function isInsidePane(y: number, paneRect: PaneRectOrNull): boolean {
  if (paneRect === null) return false;
  return y >= paneRect.y + PANE_EDGE_INSET_PX && y <= paneRect.bottom - PANE_EDGE_INSET_PX;
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
