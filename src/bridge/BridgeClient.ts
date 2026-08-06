/**
 * ISOLATED-world proxy that implements ChartBridge by forwarding calls to
 * the MAIN-world bridge over the nonced postMessage protocol (protocol.ts).
 *
 * Design note — the sync/async tension: the ChartBridge interface (§5.2)
 * is defined with synchronous methods (`priceToY(price): number | null`),
 * but a MAIN<->ISOLATED postMessage round trip is inherently asynchronous
 * — there is no synchronous cross-world call in a content script (short of
 * SharedArrayBuffer + Atomics.wait, which is not worth the complexity or
 * the COOP/COEP header requirements it would impose on a page we don't
 * control). The resolution used here: BridgeClient keeps a small
 * per-argument result cache. Reading (`priceToY(24120.5)`) returns the
 * last cached value for that exact argument synchronously (or `null` if
 * never seen), while every call also fires an async refresh in the
 * background to keep the cache warm for the *next* read. In practice a
 * round trip completes well inside one animation frame, so the anchoring
 * loop (AnchorManager, §P4) effectively reads live values with at most a
 * frame's worth of lag — and per §R-P4a, "no cached value yet" already
 * means "return null, hide the element", which is the correct behavior
 * for a chart that hasn't finished loading, not a bug to work around.
 *
 * A cache entry older than STALE_MS is treated as absent (returns null)
 * rather than served indefinitely — a torn-down or navigated-away bridge
 * must not leave the widget showing a frozen last-good coordinate forever.
 */

import type {
  ChartBridge,
  ChartBridgeId,
  ChartChangeReason,
  LastBar,
  PaneRect,
  ProbeResult,
} from './ChartBridge';
import { generateSessionNonce } from '../utils/env';
import {
  PROTOCOL_NAMESPACE,
  postProtocolMessage,
  readProtocolMessage,
  type BridgeMethodName,
} from './protocol';
import { getLogger } from '../utils/logger';

const log = getLogger('bridge:client');

const REQUEST_TIMEOUT_MS = 500;
const CACHE_STALE_MS = 2000;

interface CacheEntry {
  readonly value: unknown;
  readonly atMs: number;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req:${requestCounter}`;
}

export class BridgeClient implements ChartBridge {
  readonly id: ChartBridgeId;
  private readonly nonce: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly changeListeners = new Set<(reason: ChartChangeReason) => void>();
  private disposed = false;
  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed) return;
    const msg = readProtocolMessage(event);
    if (msg === null || msg.kind !== 'response') return;
    if (msg.nonce !== this.nonce) return;

    if (msg.id.startsWith('change:')) {
      const reason = msg.id.slice('change:'.length) as ChartChangeReason;
      for (const cb of this.changeListeners) cb(reason);
      return;
    }

    const waiter = this.pending.get(msg.id);
    if (waiter === undefined) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      waiter.resolve(msg.result);
    } else {
      waiter.reject(new Error(msg.error ?? 'bridge request failed'));
    }
  };

  constructor(id: ChartBridgeId, nonce: string) {
    this.id = id;
    this.nonce = nonce;
    window.addEventListener('message', this.onMessage);
    postProtocolMessage({ __ns: PROTOCOL_NAMESPACE, nonce: this.nonce, kind: 'init' });
  }

  private cacheKey(method: BridgeMethodName, args: readonly unknown[]): string {
    return `${method}:${JSON.stringify(args)}`;
  }

  private readCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry === undefined) return null;
    if (Date.now() - entry.atMs > CACHE_STALE_MS) return null;
    return entry.value as T;
  }

  /**
   * A genuine awaited RPC round trip — rejects on timeout or dispose. Used
   * where a caller needs a settled result, not a cached-and-possibly-stale
   * one (e.g. CapabilityProbe's startup probe, §P2).
   *
   * The timeout is cleared from inside the SAME resolve/reject wrappers
   * stored in `this.pending`, rather than via a `promise.finally()`
   * side-channel — that earlier shape needed a `.catch(() => {})` on the
   * derived `.finally()` promise to avoid an unhandled-rejection warning,
   * which is exactly the pattern §7.2 bans. This shape has nowhere for
   * that to happen.
   */
  private request<T>(method: BridgeMethodName, args: readonly unknown[]): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('bridge client disposed'));
    const id = nextRequestId();

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutHandle);
          resolve(value as T);
        },
        reject: (reason) => {
          clearTimeout(timeoutHandle);
          reject(reason);
        },
      });
    });

    timeoutHandle = setTimeout(() => {
      const waiter = this.pending.get(id);
      if (waiter !== undefined) {
        this.pending.delete(id);
        waiter.reject(new Error('bridge request timed out'));
      }
    }, REQUEST_TIMEOUT_MS);

    postProtocolMessage({
      __ns: PROTOCOL_NAMESPACE,
      nonce: this.nonce,
      kind: 'request',
      id,
      method,
      args,
    });

    return promise;
  }

  /** Fires an async RPC call and updates the cache on success. Never throws. */
  private refresh(method: BridgeMethodName, args: readonly unknown[]): void {
    if (this.disposed) return;
    const key = this.cacheKey(method, args);
    this.request<unknown>(method, args)
      .then((value) => {
        this.cache.set(key, { value, atMs: Date.now() });
      })
      .catch((error: unknown) => {
        log.debug('bridge refresh failed', { method, error: String(error) });
      });
  }

  private syncCall<T>(method: BridgeMethodName, args: readonly unknown[]): T | null {
    const key = this.cacheKey(method, args);
    this.refresh(method, args);
    return this.readCache<T>(key);
  }

  /** Awaited probe — see `request`'s doc comment. Rejects on timeout/dispose; callers should catch. */
  probeAsync(): Promise<ProbeResult> {
    return this.request<ProbeResult>('probe', []);
  }

  isAvailable(): boolean {
    return this.syncCall<boolean>('isAvailable', []) ?? false;
  }

  probe(): ProbeResult {
    const cached = this.syncCall<ProbeResult>('probe', []);
    return (
      cached ?? {
        bridgeId: this.id,
        timestampMs: Date.now(),
        checks: [
          {
            name: 'awaiting-first-response',
            passed: false,
            detail: 'no probe response cached yet',
          },
        ],
        overall: 'unavailable',
      }
    );
  }

  priceToY(price: number): number | null {
    return this.syncCall<number>('priceToY', [price]);
  }

  yToPrice(y: number): number | null {
    return this.syncCall<number>('yToPrice', [y]);
  }

  timeToX(time: number): number | null {
    return this.syncCall<number>('timeToX', [time]);
  }

  lastBar(): LastBar | null {
    return this.syncCall<LastBar>('lastBar', []);
  }

  symbol(): string | null {
    return this.syncCall<string>('symbol', []);
  }

  paneRect(): PaneRect | null {
    return this.syncCall<PaneRect>('paneRect', []);
  }

  onChange(cb: (reason: ChartChangeReason) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Full teardown — called on SPA nav / extension disable (§R-P1). */
  dispose(): void {
    this.disposed = true;
    window.removeEventListener('message', this.onMessage);
    this.changeListeners.clear();
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('bridge client disposed'));
    }
    this.pending.clear();
    this.cache.clear();
  }
}

export function createBridgeClient(id: ChartBridgeId): BridgeClient {
  return new BridgeClient(id, generateSessionNonce());
}
