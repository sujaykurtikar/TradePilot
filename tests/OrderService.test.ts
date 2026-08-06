import { describe, it, expect, vi, afterEach } from 'vitest';
import { OrderService } from '../src/background/OrderService';
import type { PlaceOrderRequest } from '../src/core/messaging/messages';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const BASE_REQUEST: PlaceOrderRequest = {
  type: 'tradepilot/place-order',
  clientOrderId: 'order-1',
  direction: 'BUY',
  lots: 1,
  strike: 24100,
  optionType: 'CE',
  sl: 24050,
  tp: 24150,
  paperMode: true,
};

describe('OrderService — §R-P6 "highest-stakes code in the project"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the documented paper endpoint and reports accepted on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const service = new OrderService('http://127.0.0.1:8000');
    const result = await service.placeOrder(BASE_REQUEST);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/paper/manual/order',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      direction: 'BUY',
      lots: 1,
      order_type: 'MARKET',
      strike: 24100,
      option_type: 'CE',
      sl: 24050,
      tp: 24150,
      strategy: 'chart-widget',
      clientOrderId: 'order-1',
    });
    expect(result.outcome).toBe('accepted');
  });

  it('refuses a live-mode order outright — no confirmed live order endpoint exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new OrderService('http://127.0.0.1:8000');
    const result = await service.placeOrder({ ...BASE_REQUEST, paperMode: false });
    expect(result.outcome).toBe('rejected');
    expect(fetchMock).not.toHaveBeenCalled(); // never even attempts the network call
  });

  it('blocks a duplicate clientOrderId submitted twice — the idempotency guard', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const service = new OrderService('http://127.0.0.1:8000');

    const first = await service.placeOrder(BASE_REQUEST);
    const second = await service.placeOrder(BASE_REQUEST);

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second call never even reaches fetch
  });

  it('reserves the clientOrderId BEFORE the network call — a near-simultaneous double-click cannot race past the check', async () => {
    let resolveFetch: () => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve(jsonResponse({}));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new OrderService('http://127.0.0.1:8000');

    const firstPromise = service.placeOrder(BASE_REQUEST);
    // Fire the second call while the first's fetch is still pending —
    // reservation must happen synchronously before any await.
    const secondResult = await service.placeOrder(BASE_REQUEST);
    expect(secondResult.outcome).toBe('rejected');

    resolveFetch();
    const firstResult = await firstPromise;
    expect(firstResult.outcome).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a distinct clientOrderId is never blocked by a prior submission', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));
    const service = new OrderService('http://127.0.0.1:8000');
    await service.placeOrder(BASE_REQUEST);
    const result = await service.placeOrder({ ...BASE_REQUEST, clientOrderId: 'order-2' });
    expect(result.outcome).toBe('accepted');
  });

  it('reports a non-2xx server response as "rejected" (not ambiguous — the server did respond)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'insufficient margin' }, false, 422)),
    );
    const service = new OrderService('http://127.0.0.1:8000');
    const result = await service.placeOrder(BASE_REQUEST);
    expect(result.outcome).toBe('rejected');
    expect(result.message).toBe('insufficient margin');
  });

  it('reports a network failure as "ambiguous", never auto-retries, and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const service = new OrderService('http://127.0.0.1:8000');
    const result = await service.placeOrder(BASE_REQUEST);
    expect(result.outcome).toBe('ambiguous');
    expect(result.message.toLowerCase()).toContain('unknown');
  });

  it('a timed-out request is also "ambiguous" (we cannot prove the server never received it)', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }),
        ),
      );
      const service = new OrderService('http://127.0.0.1:8000');
      const resultPromise = service.placeOrder(BASE_REQUEST);
      await vi.advanceTimersByTimeAsync(10_000); // OrderService's own REQUEST_TIMEOUT_MS
      const result = await resultPromise;
      expect(result.outcome).toBe('ambiguous');
    } finally {
      vi.useRealTimers();
    }
  });
});
