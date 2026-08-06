/**
 * Adjusts an open position's SL/TP (§P6t: "drag-to-adjust TP/SL on an
 * open position"). Same safety shape as OrderService — §R-P6t applies
 * R-P6's idempotency/no-auto-retry rules to `/position/risk` instead of
 * `/manual/order` — but this is a lower-stakes call than entry (it
 * adjusts risk on a position that already exists rather than creating
 * new exposure), so the idempotency guard here is simpler: one in-flight
 * request per requestId, not a permanent "never again this session"
 * record — a legitimate SECOND drag of the same pill to a different
 * price is a normal action, unlike a second identical order.
 */

import { getLogger } from '../utils/logger';
import type {
  PositionRiskOutcome,
  PositionRiskRequest,
  PositionRiskResponse,
} from '../core/messaging/messages';

const log = getLogger('background:position-risk-service');

const REQUEST_TIMEOUT_MS = 10_000;
const POSITION_RISK_PATH = '/v1/paper/position/risk';

function buildResponse(
  requestId: string,
  outcome: PositionRiskOutcome,
  message: string,
): PositionRiskResponse {
  return { type: 'tradepilot/position-risk-result', requestId, outcome, message };
}

export class PositionRiskService {
  private readonly baseUrl: string;
  private readonly inFlightRequestIds = new Set<string>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async updateRisk(req: PositionRiskRequest): Promise<PositionRiskResponse> {
    if (this.inFlightRequestIds.has(req.requestId)) {
      log.warn('refused a duplicate in-flight requestId', { requestId: req.requestId });
      return buildResponse(
        req.requestId,
        'rejected',
        'Duplicate submission blocked (already in flight).',
      );
    }
    this.inFlightRequestIds.add(req.requestId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}${POSITION_RISK_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          position_id: req.positionId,
          account: req.account,
          ...(req.sl !== undefined ? { sl: req.sl } : {}),
          ...(req.tp !== undefined ? { tp: req.tp } : {}),
        }),
      });

      if (response.ok) {
        log.info('position risk update accepted', {
          requestId: req.requestId,
          positionId: req.positionId,
        });
        return buildResponse(req.requestId, 'accepted', 'Level updated.');
      }

      let serverMessage = `HTTP ${response.status}`;
      try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'detail' in body) {
          serverMessage = String(body.detail);
        }
      } catch {
        // Non-JSON error body — keep the HTTP status as the message.
      }
      log.warn('position risk update rejected by server', {
        requestId: req.requestId,
        serverMessage,
      });
      return buildResponse(req.requestId, 'rejected', serverMessage);
    } catch (error) {
      // §R-P6t: same ambiguous-on-timeout rule as R-P6 — we cannot tell
      // whether the server actually applied this change, so the caller
      // must snap the pill back to the last SERVER-confirmed value
      // rather than trusting the optimistic drag position.
      log.error('position risk update outcome unknown', {
        requestId: req.requestId,
        error: String(error),
      });
      return buildResponse(
        req.requestId,
        'ambiguous',
        'Unknown — the request did not complete cleanly. Reverting to the last confirmed level.',
      );
    } finally {
      clearTimeout(timeout);
      this.inFlightRequestIds.delete(req.requestId);
    }
  }
}
