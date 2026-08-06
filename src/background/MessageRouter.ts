/**
 * Registers the chrome.runtime.onMessage handler and dispatches by message
 * type (§P1). Every inbound payload is validated with a guard before it's
 * trusted — an unrecognized message is logged and ignored, never crashes
 * the service worker.
 */

import { isTradePilotRequest } from '../core/messaging/guards';
import type { ApiReachability, StatusResponse, TradePilotRequest } from '../core/messaging/messages';
import type { StorageManager } from '../core/storage/StorageManager';
import { getLogger } from '../utils/logger';

const log = getLogger('background:message-router');

export interface MessageRouterDeps {
  readonly storage: StorageManager;
  /**
   * Day-1: no backend polling exists yet (that's P5), so this always
   * resolves 'not-checked' — an honest state, not a fabricated
   * "reachable" (§7.1's ranking: correct > visibly absent > ... > never
   * silently wrong). P5 replaces this with ApiClient's real reachability.
   */
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
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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
      default: {
        const _exhaustive: never = req.type;
        log.warn('unhandled request type', { type: _exhaustive });
        return false;
      }
    }
  });
}
