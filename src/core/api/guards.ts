/**
 * Runtime guards for the raw API payloads (§7.1: "Type-guard every
 * payload at the boundary — a guard, not a cast"). Nothing from
 * background/ApiClient.ts reaches a caller without passing through one of
 * these first — a malformed response is a rejected Result, never a value
 * that merely LOOKS like the right shape because a `cast` said so.
 */

import type { RawChartState, RawPosition, RawRecommend } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOptionType(value: unknown): value is 'CE' | 'PE' | null {
  return value === null || value === 'CE' || value === 'PE';
}

export function isRawPosition(value: unknown): value is RawPosition {
  if (!isRecord(value)) return false;
  return (
    typeof value.position_id === 'string' &&
    typeof value.account === 'string' &&
    typeof value.symbol === 'string' &&
    isOptionType(value.option_type) &&
    isNullableNumber(value.strike) &&
    isNullableNumber(value.entry_spot) &&
    isNullableNumber(value.sl) &&
    isNullableNumber(value.tp) &&
    isNullableNumber(value.delta) &&
    isNullableNumber(value.unrealized_pnl)
  );
}

export function isRawChartState(value: unknown): value is RawChartState {
  if (!isRecord(value)) return false;
  if (
    !isNullableNumber(value.spot) ||
    !isNullableNumber(value.atm_strike) ||
    !isNullableNumber(value.strike_interval) ||
    !isNullableNumber(value.lot_size) ||
    !isNullableString(value.expiry) ||
    typeof value.is_fresh !== 'boolean' ||
    !Array.isArray(value.positions)
  ) {
    return false;
  }
  return value.positions.every(isRawPosition);
}

export function isRawRecommend(value: unknown): value is RawRecommend {
  if (!isRecord(value)) return false;
  return (
    (value.direction === 'BUY' || value.direction === 'SELL') &&
    typeof value.recommended_symbol === 'string' &&
    isOptionType(value.recommended_option_type) &&
    isNullableNumber(value.recommended_ltp) &&
    isNullableNumber(value.sl) &&
    isNullableNumber(value.tp) &&
    isNullableNumber(value.composite_score) &&
    Array.isArray(value.rationale) &&
    value.rationale.every((r: unknown) => typeof r === 'string')
  );
}
