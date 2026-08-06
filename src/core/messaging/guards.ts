/**
 * Runtime type guards for messages crossing the extension-context boundary
 * (§7.1 "type-guard every payload at the boundary — a guard, not a cast").
 * chrome.runtime message payloads are `unknown` at the JS engine level
 * regardless of what TypeScript's ambient types claim; never trust the
 * shape without checking.
 */

import type { GetStatusRequest, TradePilotRequest } from './messages';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isGetStatusRequest(value: unknown): value is GetStatusRequest {
  return isRecord(value) && value.type === 'tradepilot/get-status';
}

export function isTradePilotRequest(value: unknown): value is TradePilotRequest {
  return isGetStatusRequest(value);
}
