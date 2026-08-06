import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from '../src/background/ApiClient';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const VALID_CHART_STATE = {
  spot: 24120.5,
  atm_strike: 24100,
  strike_interval: 50,
  lot_size: 75,
  expiry: '2026-08-07',
  is_fresh: true,
  positions: [],
};

const VALID_RECOMMEND = {
  direction: 'BUY',
  recommended_symbol: 'NIFTY',
  recommended_option_type: 'CE',
  recommended_ltp: 145.5,
  sl: 130,
  tp: 180,
  composite_score: 0.82,
  rationale: [],
};

describe('ApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchChartState hits the correct endpoint and returns ok on a well-formed response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_CHART_STATE));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
    const result = await client.fetchChartState(new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/paper/chart/state',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(VALID_CHART_STATE);
  });

  it('fetchRecommend hits the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_RECOMMEND));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
    const result = await client.fetchRecommend(new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/paper/recommend',
      expect.anything(),
    );
    expect(result.ok).toBe(true);
  });

  it('strips a trailing slash from baseUrl so the path never doubles up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_CHART_STATE));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000/' });
    await client.fetchChartState(new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/paper/chart/state',
      expect.anything(),
    );
  });

  it('rejects a well-formed JSON body that fails shape validation (§7.1 guard, not a cast)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ totally: 'wrong shape' })));
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
    const result = await client.fetchChartState(new AbortController().signal);
    expect(result.ok).toBe(false);
  });

  it('reports a non-2xx HTTP status as an error, not a thrown exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 503)));
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
    const result = await client.fetchChartState(new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('503');
  });

  it('reports a network-level rejection (server unreachable) as an error, not a thrown exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
    const result = await client.fetchChartState(new AbortController().signal);
    expect(result.ok).toBe(false);
  });

  it('reports an aborted request distinctly', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        controller.abort();
        const err = new DOMException('aborted', 'AbortError');
        return Promise.reject(err);
      }),
    );
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
    const result = await client.fetchChartState(controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('aborted');
  });
});
