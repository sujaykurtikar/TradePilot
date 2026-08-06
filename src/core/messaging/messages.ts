/**
 * Typed chrome.runtime messages between popup/content <-> background
 * (§P1: "Typed message bus"). This file is the single place new message
 * shapes get added, so a request/response pair can never silently drift
 * out of sync between sender and handler.
 */

import type { MarketDataSnapshot } from '../api/types';

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

/** content -> background: reports this tab's document.visibilityState (§P5 "poll only when the tab is visible"). No response expected. */
export interface TabVisibilityMessage {
  readonly type: 'tradepilot/tab-visibility';
  readonly visible: boolean;
}

/** background -> content, pushed via chrome.tabs.sendMessage after every poll cycle (§P5: "merges, validates, pushes to the content script"). No response expected. */
export interface DataUpdateMessage {
  readonly type: 'tradepilot/data-update';
  readonly snapshot: MarketDataSnapshot;
}

export type TradePilotRequest = GetStatusRequest | TabVisibilityMessage;
export type TradePilotPush = DataUpdateMessage;
export type TradePilotResponse = StatusResponse;
