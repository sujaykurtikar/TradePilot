/**
 * The ChartBridge interface (IMPLEMENTATION_PLAN.md §5.2). One
 * implementation per chart host; the widget layer (src/widget/**, src/content/**)
 * knows only this interface — never a vendor global.
 */

export type ChartBridgeId = 'tradingview-site' | 'kotak-neo' | 'lightweight-charts';

export interface ProbeCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/**
 * §5.4's degradation ladder outcome. 'full' = anchoring works, render on
 * the chart. 'degraded' = coordinate math failed but the bridge object
 * exists — manual mode (§R-P2). 'unavailable' = bridge absent entirely —
 * widget does not mount.
 */
export type ProbeOverall = 'full' | 'degraded' | 'unavailable';

export interface ProbeResult {
  readonly bridgeId: ChartBridgeId;
  readonly timestampMs: number;
  readonly checks: readonly ProbeCheckResult[];
  readonly overall: ProbeOverall;
}

export interface LastBar {
  readonly time: number;
  readonly close: number;
}

/** Plain-object mirror of DOMRect (postMessage-cloneable; a real DOMRect isn't structured-cloneable in all engines). */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

export type ChartChangeReason = 'range' | 'symbol' | 'interval' | 'resize';

export interface ChartBridge {
  readonly id: ChartBridgeId;
  isAvailable(): boolean;
  probe(): ProbeResult;
  /** viewport px, null = off-screen or unavailable — never guess (§7.1/§R-P4a) */
  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
  timeToX(time: number): number | null;
  lastBar(): LastBar | null;
  symbol(): string | null;
  /**
   * The chart pane's viewport rect. Not in the plan's original §5.2
   * sketch, but its own §P4 anchoring pseudocode reads `paneRect.right`
   * directly for right-pinned elements (the Suggested card riding the
   * live price at the pane's edge, Zing-style) — so it has to come from
   * somewhere. Added here rather than invented ad hoc in the widget layer,
   * since pane geometry is exactly the kind of vendor-internal detail the
   * bridge exists to own.
   */
  paneRect(): PaneRect | null;
  onChange(cb: (reason: ChartChangeReason) => void): () => void;
}
