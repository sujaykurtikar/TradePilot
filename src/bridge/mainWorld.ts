/**
 * MAIN-world entry point (IMPLEMENTATION_PLAN.md §5.1). Injected by the
 * manifest's `world: "MAIN"` content-script entries. This file — and
 * everything it imports from src/bridge/** — is the ONLY code in the
 * project allowed to touch host-page chart internals.
 *
 * Responsibilities: pick the right host config for the current
 * location/frame, instantiate TradingViewInternalApiBridge, and serve the
 * nonced RPC protocol (protocol.ts) so the ISOLATED-world content script
 * can call bridge methods across the world boundary.
 */

import { TradingViewInternalApiBridge } from './adapters/TradingViewInternalApiBridge';
import { resolveHostConfigForLocation } from './adapters/hostConfigs';
import type { ChartBridge } from './ChartBridge';
import {
  PROTOCOL_NAMESPACE,
  postProtocolMessage,
  readProtocolMessage,
  type BridgeMethodName,
  type RequestMessage,
} from './protocol';
import { getLogger } from '../utils/logger';

const log = getLogger('bridge:main-world');

function main(): void {
  const hostConfig = resolveHostConfigForLocation(window.location);
  if (hostConfig === null) {
    // Not a recognized chart host/frame — nothing to do. This is expected
    // and silent for e.g. Kotak's outer document/middle iframe, since the
    // manifest injects into all frames but only the innermost blob iframe
    // actually has the chart (§4.2).
    return;
  }

  const bridge: ChartBridge = new TradingViewInternalApiBridge(hostConfig);
  let acceptedNonce: string | null = null;

  const dispatch = (method: BridgeMethodName, args: readonly unknown[]): unknown => {
    switch (method) {
      case 'isAvailable':
        return bridge.isAvailable();
      case 'probe':
        return bridge.probe();
      case 'priceToY':
        return bridge.priceToY(args[0] as number);
      case 'yToPrice':
        return bridge.yToPrice(args[0] as number);
      case 'timeToX':
        return bridge.timeToX(args[0] as number);
      case 'lastBar':
        return bridge.lastBar();
      case 'symbol':
        return bridge.symbol();
      case 'paneRect':
        return bridge.paneRect();
      default: {
        const _exhaustive: never = method;
        throw new Error(`unknown bridge method: ${String(_exhaustive)}`);
      }
    }
  };

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = readProtocolMessage(event);
    if (msg === null) return;

    if (msg.kind === 'init') {
      // First init handshake wins for this page load — a single content
      // script instance per frame (§R-P1's injection guard) means this
      // should only ever fire once.
      if (acceptedNonce === null) {
        acceptedNonce = msg.nonce;
        log.debug('accepted content-script nonce');
      }
      return;
    }

    if (msg.kind === 'request') {
      if (acceptedNonce === null || msg.nonce !== acceptedNonce) {
        log.warn('rejected request with unknown nonce', { method: msg.method });
        return;
      }
      const req: RequestMessage = msg;
      let ok = true;
      let result: unknown;
      let error: string | undefined;
      try {
        result = dispatch(req.method, req.args);
      } catch (e) {
        ok = false;
        error = String(e);
        log.error(
          'bridge dispatch threw — this should never happen (all bridge methods must be guarded)',
          {
            method: req.method,
            error,
          },
        );
      }
      postProtocolMessage(
        ok
          ? {
              __ns: PROTOCOL_NAMESPACE,
              nonce: acceptedNonce,
              kind: 'response',
              id: req.id,
              ok,
              result,
            }
          : {
              __ns: PROTOCOL_NAMESPACE,
              nonce: acceptedNonce,
              kind: 'response',
              id: req.id,
              ok,
              error: error ?? 'unknown error',
            },
      );
    }
  });

  // Also broadcast bridge-side change events (range/symbol/interval/resize)
  // to the content script so it can re-anchor without polling.
  bridge.onChange((reason) => {
    if (acceptedNonce === null) return;
    postProtocolMessage({
      __ns: PROTOCOL_NAMESPACE,
      nonce: acceptedNonce,
      kind: 'response',
      id: `change:${reason}`,
      ok: true,
      result: { changeEvent: reason },
    });
  });

  log.info('bridge ready', { hostId: hostConfig.id });
}

main();
