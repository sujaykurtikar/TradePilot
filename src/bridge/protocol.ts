/**
 * Nonced, same-frame postMessage RPC between the ISOLATED-world content
 * script and the MAIN-world bridge script (IMPLEMENTATION_PLAN.md §4.2/§5.1).
 *
 * Why this exists at all: `window.TradingViewApi` (and Kotak's
 * `tradingViewApi`) live in the page's own JS world. Content scripts run in
 * an isolated world and cannot see them — a manifest `world: "MAIN"`
 * content script can, but then the ISOLATED-world widget code can't see
 * *that* either. The only channel between the two worlds in the same frame
 * is `window.postMessage`.
 *
 * Security note from §4.2/§5.1: "a page script can post into the isolated
 * world" — the origin check alone (`event.origin === location.origin`)
 * doesn't distinguish our own MAIN-world bridge from any other same-origin
 * page script, since same-origin scripts share `location.origin` by
 * definition. The per-session nonce is the actual defense: the ISOLATED
 * side generates it, hands it to the MAIN-world bridge once via an `init`
 * handshake, and every request/response after that must carry it. A
 * same-origin page script that doesn't know the nonce can't make our
 * content script accept a spoofed response.
 */

export const PROTOCOL_NAMESPACE = '__tradepilot_bridge__' as const;

export type BridgeMethodName =
  | 'isAvailable'
  | 'probe'
  | 'priceToY'
  | 'yToPrice'
  | 'timeToX'
  | 'lastBar'
  | 'symbol';

interface EnvelopeBase {
  readonly __ns: typeof PROTOCOL_NAMESPACE;
  readonly nonce: string;
}

export interface InitMessage extends EnvelopeBase {
  readonly kind: 'init';
}

export interface RequestMessage extends EnvelopeBase {
  readonly kind: 'request';
  readonly id: string;
  readonly method: BridgeMethodName;
  readonly args: readonly unknown[];
}

export interface ResponseMessage extends EnvelopeBase {
  readonly kind: 'response';
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export type ProtocolMessage = InitMessage | RequestMessage | ResponseMessage;

export function isProtocolMessage(data: unknown): data is ProtocolMessage {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  return (
    rec.__ns === PROTOCOL_NAMESPACE &&
    typeof rec.nonce === 'string' &&
    (rec.kind === 'init' || rec.kind === 'request' || rec.kind === 'response')
  );
}

/**
 * Validates a raw MessageEvent against the same-frame protocol rules from
 * §4.2: `event.source === window` (rules out any other frame — including a
 * spoofed one) and `event.origin === location.origin` (rules out a
 * cross-origin sender). Returns the parsed message or null.
 */
export function readProtocolMessage(event: MessageEvent): ProtocolMessage | null {
  if (event.source !== window) return null;
  if (event.origin !== location.origin) return null;
  if (!isProtocolMessage(event.data)) return null;
  return event.data;
}

export function postProtocolMessage(message: ProtocolMessage): void {
  window.postMessage(message, location.origin);
}
