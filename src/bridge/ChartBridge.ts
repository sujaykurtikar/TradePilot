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
  onChange(cb: (reason: ChartChangeReason) => void): () => void;
}
