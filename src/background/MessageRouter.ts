/**
 * Registers the chrome.runtime.onMessage handler and dispatches by message
 * type (§P1). Every inbound payload is validated with a guard before it's
 * trusted — an unrecognized message is logged and ignored, never crashes
 * the service worker.
 */

import { isTradePilotRequest } from '../core/messaging/guards';
import type {
  ApiReachability,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PositionRiskRequest,
  PositionRiskResponse,
  StatusResponse,
  TradePilotRequest,
} from '../core/messaging/messages';
import type { StorageManager } from '../core/storage/StorageManager';
import type { TabRegistry } from './TabRegistry';
import { getLogger } from '../utils/logger';

const log = getLogger('background:message-router');

/** Narrow interface OrderService satisfies — keeps this router testable without a real fetch-backed service. */
export interface OrderPlacer {
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse>;
}

/** Narrow interface PositionRiskService satisfies — same testability rationale as OrderPlacer. */
export interface PositionRiskUpdater {
  updateRisk(req: PositionRiskRequest): Promise<PositionRiskResponse>;
}

export interface MessageRouterDeps {
  readonly storage: StorageManager;
  readonly tabRegistry: TabRegistry;
  readonly orderService: OrderPlacer;
  readonly positionRiskService: PositionRiskUpdater;
  readonly getApiStatus: () => ApiReachability;
}

async function handleGetStatus(deps: MessageRouterDeps): Promise<StatusResponse> {
  const state = await deps.storage.load();
  return {
    type: 'tradepilot/status',
    version: chrome.runtime.getManifest().version,
    enabled: state.enabled,
    apiStatus: deps.getApiStatus(),
  };
}

export function registerMessageRouter(deps: MessageRouterDeps): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isTradePilotRequest(message)) {
      log.debug('ignoring unrecognized message', { message });
      return false; // no async response coming
    }

    const req: TradePilotRequest = message;
    switch (req.type) {
      case 'tradepilot/get-status':
        handleGetStatus(deps)
          .then(sendResponse)
          .catch((error: unknown) => {
            log.error('get-status handler failed', { error: String(error) });
            sendResponse(null);
          });
        return true; // keep the message channel open for the async sendResponse
      case 'tradepilot/tab-visibility': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          deps.tabRegistry.setVisibility(tabId, req.visible);
        }
        return false; // no response expected
      }
      case 'tradepilot/place-order':
        deps.orderService
          .placeOrder(req)
          .then(sendResponse)
          .catch((error: unknown) => {
            // placeOrder() itself is designed to never throw (every path
            // returns a PlaceOrderResponse) — this catch exists only as
            // the required backstop, and if it ever fires that's itself
            // a bug worth knowing about loudly.
            log.error('place-order handler threw unexpectedly', { error: String(error) });
            sendResponse({
              type: 'tradepilot/order-result',
              clientOrderId: req.clientOrderId,
              outcome: 'ambiguous',
              message: 'Unknown — check positions. An internal error occurred handling the order.',
            });
          });
        return true;
      case 'tradepilot/position-risk':
        deps.positionRiskService
          .updateRisk(req)
          .then(sendResponse)
          .catch((error: unknown) => {
            log.error('position-risk handler threw unexpectedly', { error: String(error) });
            sendResponse({
              type: 'tradepilot/position-risk-result',
              requestId: req.requestId,
              outcome: 'ambiguous',
              message: 'Unknown — an internal error occurred handling the request.',
            });
          });
        return true;
      default: {
        const _exhaustive: never = req;
        log.warn('unhandled request type', { request: _exhaustive });
        return false;
      }
    }
  });
}
