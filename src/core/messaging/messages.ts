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

/**
 * content -> background: submit the entry order (§P6/§R-P6 — "the
 * highest-stakes code in the project"). `clientOrderId` is the
 * idempotency key: content/Bootstrap.ts generates it fresh per Trade
 * click and the SAME value must never be sent twice, which is what makes
 * a double-click or an ambiguous-timeout retry safe to reason about.
 *
 * Only paper orders are wired end to end (§2's documented endpoint is
 * `POST /v1/paper/manual/order`). §2 also lists `/v1/execution/execute`
 * as a "live execution + kill switch" endpoint, but its shape reads like
 * a system-wide start/stop switch, not a per-click manual order call —
 * there is no documented live equivalent of `/v1/paper/manual/order`'s
 * per-order contract. Rather than guess an unconfirmed live order
 * endpoint for what the plan itself calls the highest-stakes code here,
 * `paperMode: false` is accepted by this message shape (so the UI toggle
 * can exist and be visually distinct, §P6) but OrderService refuses to
 * submit it — see OrderService.ts.
 */
export interface PlaceOrderRequest {
  readonly type: 'tradepilot/place-order';
  readonly clientOrderId: string;
  readonly direction: 'BUY' | 'SELL';
  readonly lots: number;
  readonly strike: number;
  readonly optionType: 'CE' | 'PE';
  readonly sl: number | null;
  readonly tp: number | null;
  readonly paperMode: boolean;
}

export type PlaceOrderOutcome = 'accepted' | 'rejected' | 'ambiguous';

export interface PlaceOrderResponse {
  readonly type: 'tradepilot/order-result';
  readonly clientOrderId: string;
  readonly outcome: PlaceOrderOutcome;
  readonly message: string;
}

export type TradePilotRequest = GetStatusRequest | TabVisibilityMessage | PlaceOrderRequest;
export type TradePilotPush = DataUpdateMessage;
export type TradePilotResponse = StatusResponse | PlaceOrderResponse;
