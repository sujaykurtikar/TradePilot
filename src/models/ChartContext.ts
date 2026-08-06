/**
 * Mirrors the non-position part of `GET /v1/paper/chart/state`
 * (IMPLEMENTATION_PLAN.md §2), plus `is_fresh` which drives the staleness
 * rules in §7.1/§R-P5.
 */

export interface ChartContext {
  readonly spot: number | null;
  readonly atmStrike: number | null;
  readonly strikeInterval: number | null;
  readonly lotSize: number | null;
  readonly expiry: string | null;
  readonly isFresh: boolean;
  readonly receivedAtMs: number;
}

/**
 * Which host page + symbol the widget is currently anchored to. `hostId`
 * selects the ChartBridge implementation (§5.2); `chartSymbol` is the raw
 * string the chart reports (e.g. `"NSE_CM|NIFTY 50"` on Kotak, §4.2) before
 * it's run through the per-host symbol map to our instrument name.
 */
export interface ChartHostContext {
  readonly hostId: 'tradingview-site' | 'kotak-neo';
  readonly chartSymbol: string | null;
  /** our instrument name after symbol-map lookup; null = unmapped (§R-P5) */
  readonly mappedSymbol: string | null;
}
