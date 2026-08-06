/**
 * Wire shapes for our backend's endpoints (IMPLEMENTATION_PLAN.md §2),
 * kept separate from src/models/** (which are OUR internal camelCase
 * shapes). Field names here mirror the backend's own naming
 * (snake_case, per §2's literal field list) — mappers.ts converts these
 * to the internal models; nothing outside src/core/api/** should touch
 * these raw shapes directly.
 *
 * Every optional numeric field is typed `number | null` because the
 * backend types them `Optional[float]` and *will* send null (§P5/§7.1) —
 * this file exists specifically so that fact is enforced by the type
 * system, not just remembered.
 */

import type { ChartContext } from '../../models/ChartContext';
import type { Position } from '../../models/Position';
import type { Suggestion } from '../../models/Suggestion';

export interface RawPosition {
  readonly position_id: string;
  readonly account: string;
  readonly symbol: string;
  readonly option_type: 'CE' | 'PE' | null;
  readonly strike: number | null;
  readonly entry_spot: number | null;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly delta: number | null;
  readonly unrealized_pnl: number | null;
}

export interface RawChartState {
  readonly spot: number | null;
  readonly atm_strike: number | null;
  readonly strike_interval: number | null;
  readonly lot_size: number | null;
  readonly expiry: string | null;
  readonly is_fresh: boolean;
  readonly positions: readonly RawPosition[];
}

export interface RawRecommend {
  readonly direction: 'BUY' | 'SELL';
  readonly recommended_symbol: string;
  readonly recommended_option_type: 'CE' | 'PE' | null;
  readonly recommended_ltp: number | null;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly composite_score: number | null;
  readonly rationale: readonly string[];
}

/**
 * The merged, mapped result of one poll cycle (§P5: "merges, validates,
 * pushes to the content script"). This is what DataPoller produces and
 * what gets pushed to content scripts — never the raw wire shapes above.
 */
export interface MarketDataSnapshot {
  readonly chartContext: ChartContext | null;
  readonly positions: readonly Position[];
  readonly suggestion: Suggestion | null;
  readonly lastSuccessAtMs: number | null;
  readonly lastError: string | null;
}

export const EMPTY_MARKET_DATA_SNAPSHOT: MarketDataSnapshot = {
  chartContext: null,
  positions: [],
  suggestion: null,
  lastSuccessAtMs: null,
  lastError: null,
};
