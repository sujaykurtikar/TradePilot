/**
 * Runtime type guards for messages crossing the extension-context boundary
 * (§7.1 "type-guard every payload at the boundary — a guard, not a cast").
 * chrome.runtime message payloads are `unknown` at the JS engine level
 * regardless of what TypeScript's ambient types claim; never trust the
 * shape without checking.
 */

import type {
  DataUpdateMessage,
  GetStatusRequest,
  PlaceOrderRequest,
  PositionRiskRequest,
  TabVisibilityMessage,
  TradePilotRequest,
} from './messages';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

export function isGetStatusRequest(value: unknown): value is GetStatusRequest {
  return isRecord(value) && value.type === 'tradepilot/get-status';
}

export function isTabVisibilityMessage(value: unknown): value is TabVisibilityMessage {
  return (
    isRecord(value) &&
    value.type === 'tradepilot/tab-visibility' &&
    typeof value.visible === 'boolean'
  );
}

/** §R-P6: this is the order-submission path — validate every field, not just the envelope. */
export function isPlaceOrderRequest(value: unknown): value is PlaceOrderRequest {
  if (!isRecord(value) || value.type !== 'tradepilot/place-order') return false;
  return (
    typeof value.clientOrderId === 'string' &&
    value.clientOrderId.length > 0 &&
    (value.direction === 'BUY' || value.direction === 'SELL') &&
    isFiniteNumber(value.lots) &&
    value.lots > 0 &&
    isFiniteNumber(value.strike) &&
    (value.optionType === 'CE' || value.optionType === 'PE') &&
    isNullableFiniteNumber(value.sl) &&
    isNullableFiniteNumber(value.tp) &&
    typeof value.paperMode === 'boolean'
  );
}

/** §R-P6t: sl/tp are each OPTIONAL (a partial update sends only the field that changed) but if present must be finite — never NaN reaching the network. */
export function isPositionRiskRequest(value: unknown): value is PositionRiskRequest {
  if (!isRecord(value) || value.type !== 'tradepilot/position-risk') return false;
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
  if (typeof value.positionId !== 'string' || value.positionId.length === 0) return false;
  if (typeof value.account !== 'string' || value.account.length === 0) return false;
  if ('sl' in value && value.sl !== undefined && !isFiniteNumber(value.sl)) return false;
  if ('tp' in value && value.tp !== undefined && !isFiniteNumber(value.tp)) return false;
  return value.sl !== undefined || value.tp !== undefined; // at least one field must actually change
}

export function isTradePilotRequest(value: unknown): value is TradePilotRequest {
  return (
    isGetStatusRequest(value) ||
    isTabVisibilityMessage(value) ||
    isPlaceOrderRequest(value) ||
    isPositionRiskRequest(value)
  );
}

/** Loose on purpose — the snapshot's internal shape is trusted because WE produced it in the background (mapChartState/mapRecommend already guarded it on the way in); this just confirms the envelope. */
export function isDataUpdateMessage(value: unknown): value is DataUpdateMessage {
  return isRecord(value) && value.type === 'tradepilot/data-update' && isRecord(value.snapshot);
}
