/**
 * Mirrors `GET /v1/paper/recommend` (IMPLEMENTATION_PLAN.md §2).
 *
 * Every price field is nullable — the backend types them `Optional[float]`
 * and *will* send null (§P5/R-P5). Nothing downstream may coalesce a
 * missing price to 0; a missing field means "hide that element", never
 * "treat as zero" (§7.1 "No `?? 0`, ever").
 */

export type Direction = 'BUY' | 'SELL';
export type OptionType = 'CE' | 'PE';

export interface Suggestion {
  readonly direction: Direction;
  readonly recommendedSymbol: string;
  readonly recommendedOptionType: OptionType | null;
  readonly recommendedLtp: number | null;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly compositeScore: number | null;
  readonly rationale: readonly string[];
  /**
   * The spot/ltp this suggestion was computed against, stamped at receive
   * time. Used by P6's slippage guard: if live price has since moved
   * beyond tolerance, the Trade flow must block and re-prompt rather than
   * submit against a stale suggestion (§P6 "Slippage guard").
   */
  readonly computedAtPrice: number | null;
  /** local receive timestamp (ms epoch), for staleness checks (§R-P5) */
  readonly receivedAtMs: number;
}
