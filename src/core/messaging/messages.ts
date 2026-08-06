/**
 * Typed chrome.runtime messages between popup <-> background (§P1: "Typed
 * message bus"). Extended in P5 (chart-state push) and P6 (order submit)
 * — this file is the single place new message shapes get added, so a
 * request/response pair can never silently drift out of sync between
 * sender and handler.
 */

export interface GetStatusRequest {
  readonly type: 'tradepilot/get-status';
}

export type ApiReachability = 'not-checked' | 'reachable' | 'unreachable';

export interface StatusResponse {
  readonly type: 'tradepilot/status';
  readonly version: string;
  readonly enabled: boolean;
  readonly apiStatus: ApiReachability;
}

export type TradePilotRequest = GetStatusRequest;
export type TradePilotResponse = StatusResponse;
