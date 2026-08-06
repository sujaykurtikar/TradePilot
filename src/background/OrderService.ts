/**
 * Places the entry order (§P6/§R-P6 — "the highest-stakes code in the
 * project"). Per §3: this call is ENTRY ONLY — `sl`/`tp` are recorded as
 * OUR managed levels and enforced server-side by trade_management, never
 * sent as broker OCO legs.
 *
 * §R-P6 requirements this file is responsible for:
 *  - Idempotency key: every request carries `clientOrderId`, generated
 *    fresh per Trade click by the caller. This service also keeps its
 *    own in-memory record of ids it has already submitted THIS SESSION
 *    and refuses a repeat — defense in depth, not a replacement for
 *    server-side dedup. §P6 says plainly: "If the backend doesn't
 *    dedupe today, that is a required backend change before P6 — not
 *    optional." This extension cannot make that backend change (it
 *    lives in a separate repo); the client-side guard here reduces but
 *    does not eliminate the double-order risk of a truly concurrent
 *    double-click racing two message sends before either resolves.
 *  - No auto-retry: exactly one fetch, ever, per clientOrderId.
 *  - Ambiguous-outcome handling: a request that we can't prove reached
 *    the server (timeout, network drop) is reported as 'ambiguous', NOT
 *    'rejected' — a caller must never auto-retry an ambiguous result,
 *    since the order may have actually gone through.
 *
 * Live trading is deliberately NOT wired here — see messages.ts's
 * PlaceOrderRequest doc comment for why. `paperMode: false` is accepted
 * as a valid message shape (so the UI toggle can exist) but rejected
 * here with an explicit, non-silent reason.
 */

import { getLogger } from '../utils/logger';
import type {
  PlaceOrderOutcome,
  PlaceOrderRequest,
  PlaceOrderResponse,
} from '../core/messaging/messages';

const log = getLogger('background:order-service');

const REQUEST_TIMEOUT_MS = 10_000;
const PAPER_ORDER_PATH = '/v1/paper/manual/order';

function buildResponse(
  clientOrderId: string,
  outcome: PlaceOrderOutcome,
  message: string,
): PlaceOrderResponse {
  return { type: 'tradepilot/order-result', clientOrderId, outcome, message };
}

export class OrderService {
  private readonly baseUrl: string;
  private readonly submittedIds = new Set<string>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    if (!req.paperMode) {
      // See messages.ts's doc comment: no confirmed live per-order
      // endpoint exists in the documented contract. Refusing loudly is
      // the only responsible option for the highest-stakes call in the
      // project rather than guessing.
      log.error('refused a live-mode order — no confirmed live order endpoint exists', {
        clientOrderId: req.clientOrderId,
      });
      return buildResponse(
        req.clientOrderId,
        'rejected',
        'Live trading is not wired yet — no confirmed live order endpoint (see IMPLEMENTATION_PLAN.md §10 Q4). Switch to Paper.',
      );
    }

    if (this.submittedIds.has(req.clientOrderId)) {
      log.warn('refused a duplicate clientOrderId — already submitted this session', {
        clientOrderId: req.clientOrderId,
      });
      return buildResponse(
        req.clientOrderId,
        'rejected',
        'Duplicate submission blocked (same order already sent this session).',
      );
    }
    // Reserve the id BEFORE the network call, not after — a fast
    // double-click firing two placeOrder() calls back to back must not
    // race past this check while the first fetch is still in flight.
    this.submittedIds.add(req.clientOrderId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}${PAPER_ORDER_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          direction: req.direction,
          lots: req.lots,
          order_type: 'MARKET',
          strike: req.strike,
          option_type: req.optionType,
          sl: req.sl,
          tp: req.tp,
          strategy: 'chart-widget',
          clientOrderId: req.clientOrderId,
        }),
      });

      if (response.ok) {
        log.info('order accepted', { clientOrderId: req.clientOrderId });
        return buildResponse(req.clientOrderId, 'accepted', 'Order placed.');
      }

      // A response DID come back — the server saw the request and said
      // no. That's a clean rejection, not an ambiguous one; the id stays
      // reserved (a rejected order should not be silently retryable
      // under the same key — the caller generates a fresh clientOrderId
      // for an intentional new attempt).
      let serverMessage = `HTTP ${response.status}`;
      try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'detail' in body) {
          serverMessage = String(body.detail);
        }
      } catch {
        // Non-JSON error body — keep the HTTP status as the message.
      }
      log.warn('order rejected by server', { clientOrderId: req.clientOrderId, serverMessage });
      return buildResponse(req.clientOrderId, 'rejected', serverMessage);
    } catch (error) {
      // Network failure or our own timeout abort — we cannot tell
      // whether the server received and acted on this order.
      // §R-P6: "Ambiguous timeout ⇒ Unknown — check positions, never a
      // retry." This is exactly that case.
      log.error('order outcome unknown — request did not complete cleanly', {
        clientOrderId: req.clientOrderId,
        error: String(error),
      });
      return buildResponse(
        req.clientOrderId,
        'ambiguous',
        'Unknown — check positions. The request did not complete cleanly and we cannot confirm whether it was placed.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
