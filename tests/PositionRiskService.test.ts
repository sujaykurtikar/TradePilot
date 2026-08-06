import { describe, it, expect, vi, afterEach } from 'vitest';
import { PositionRiskService } from '../src/background/PositionRiskService';
import type { PositionRiskRequest } from '../src/core/messaging/messages';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const BASE_REQUEST: PositionRiskRequest = {
  type: 'tradepilot/position-risk',
  requestId: 'req-1',
  positionId: 'pos-1',
  account: 'acct-1',
  sl: 24050,
};

describe('PositionRiskService — §P6t/§R-P6t', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the documented position/risk endpoint with only the changed field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const service = new PositionRiskService('http://127.0.0.1:8000');

    const result = await service.updateRisk(BASE_REQUEST);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/paper/position/risk',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ position_id: 'pos-1', account: 'acct-1', sl: 24050 });
    expect('tp' in body).toBe(false); // tp was never provided — must not appear as undefined/null
    expect(result.outcome).toBe('accepted');
  });

  it('sends tp when that is the field provided instead of sl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const service = new PositionRiskService('http://127.0.0.1:8000');
    const { sl: _drop, ...withoutSl } = BASE_REQUEST;
    await service.updateRisk({ ...withoutSl, tp: 24200 });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ position_id: 'pos-1', account: 'acct-1', tp: 24200 });
  });

  it('rejects a second call reusing a requestId that is still in flight', async () => {
    let resolveFetch: () => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve(jsonResponse({}));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new PositionRiskService('http://127.0.0.1:8000');

    const firstPromise = service.updateRisk(BASE_REQUEST);
    const secondResult = await service.updateRisk(BASE_REQUEST);
    expect(secondResult.outcome).toBe('rejected');

    resolveFetch();
    const firstResult = await firstPromise;
    expect(firstResult.outcome).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the SAME requestId can be reused again once the first call has completed — unlike OrderService, this is not a permanent lock', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));
    const service = new PositionRiskService('http://127.0.0.1:8000');
    const first = await service.updateRisk(BASE_REQUEST);
    const second = await service.updateRisk(BASE_REQUEST);
    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('accepted');
  });

  it('reports a non-2xx response as rejected with the server detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'SL must be below entry' }, false, 422)),
    );
    const service = new PositionRiskService('http://127.0.0.1:8000');
    const result = await service.updateRisk(BASE_REQUEST);
    expect(result.outcome).toBe('rejected');
    expect(result.message).toBe('SL must be below entry');
  });

  it('reports a network failure or timeout as ambiguous, never as a silent failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const service = new PositionRiskService('http://127.0.0.1:8000');
    const result = await service.updateRisk(BASE_REQUEST);
    expect(result.outcome).toBe('ambiguous');
  });
});
