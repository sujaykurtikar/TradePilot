/**
 * Converts guarded raw API payloads (types.ts) to our internal camelCase
 * models (src/models/**). This is the one place snake_case-vs-camelCase
 * and "backend Optional[float] -> our `| null`" translation happens.
 */

import type { RawChartState, RawPosition, RawRecommend } from './types';
import type { ChartContext } from '../../models/ChartContext';
import type { Position } from '../../models/Position';
import type { Suggestion } from '../../models/Suggestion';

export function mapPosition(raw: RawPosition): Position {
  return {
    positionId: raw.position_id,
    account: raw.account,
    symbol: raw.symbol,
    optionType: raw.option_type,
    strike: raw.strike,
    entrySpot: raw.entry_spot,
    sl: raw.sl,
    tp: raw.tp,
    delta: raw.delta,
    unrealizedPnl: raw.unrealized_pnl,
  };
}

export function mapChartState(raw: RawChartState, nowMs: number): ChartContext {
  return {
    spot: raw.spot,
    atmStrike: raw.atm_strike,
    strikeInterval: raw.strike_interval,
    lotSize: raw.lot_size,
    expiry: raw.expiry,
    isFresh: raw.is_fresh,
    receivedAtMs: nowMs,
  };
}

export function mapPositions(raw: RawChartState): readonly Position[] {
  return raw.positions.map(mapPosition);
}

/**
 * `computedAtPrice` feeds P6's slippage guard ("stamp the suggestion with
 * the price it was computed at"). The endpoint table (§2) doesn't name a
 * separate "price at computation" field distinct from `recommended_ltp`,
 * so that's what's used here — it IS the price the recommendation was
 * generated against. Revisit if the backend ever adds a more explicit
 * field for this.
 */
export function mapRecommend(raw: RawRecommend, nowMs: number): Suggestion {
  return {
    direction: raw.direction,
    recommendedSymbol: raw.recommended_symbol,
    recommendedOptionType: raw.recommended_option_type,
    recommendedLtp: raw.recommended_ltp,
    sl: raw.sl,
    tp: raw.tp,
    compositeScore: raw.composite_score,
    rationale: raw.rationale,
    computedAtPrice: raw.recommended_ltp,
    receivedAtMs: nowMs,
  };
}
