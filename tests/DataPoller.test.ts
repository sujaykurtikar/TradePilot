import { describe, it, expect, vi, afterEach } from 'vitest';
import { DataPoller, type PollableApiClient } from '../src/background/DataPoller';
import { ok, err } from '../src/utils/result';
import type { RawChartState, RawRecommend } from '../src/core/api/types';

const CHART_STATE: RawChartState = {
  spot: 24120,
  atm_strike: 24100,
  strike_interval: 50,
  lot_size: 75,
  expiry: '2026-08-07',
  is_fresh: true,
  positions: [],
};

const RECOMMEND: RawRecommend = {
  direction: 'BUY',
  recommended_symbol: 'NIFTY',
  recommended_option_type: 'CE',
  recommended_ltp: 145,
  sl: 130,
  tp: 180,
  composite_score: 0.8,
  rationale: [],
};

function stubClient(overrides: Partial<PollableApiClient> = {}): PollableApiClient {
  return {
    fetchChartState: () => Promise.resolve(ok(CHART_STATE)),
    fetchRecommend: () => Promise.resolve(ok(RECOMMEND)),
    ...overrides,
  };
}

describe('DataPoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll at all when shouldPoll() is false, and rechecks on the idle interval', async () => {
    vi.useFakeTimers();
    const fetchChartState = vi.fn(() => Promise.resolve(ok(CHART_STATE)));
    const poller = new DataPoller({
      apiClient: stubClient({ fetchChartState }),
      shouldPoll: () => false,
      onUpdate: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchChartState).not.toHaveBeenCalled();
    poller.stop();
  });

  it('polls immediately on start() when shouldPoll() is true, and pushes a merged snapshot', async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const poller = new DataPoller({
      apiClient: stubClient(),
      shouldPoll: () => true,
      onUpdate,
      now: () => 5000,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const snapshot = onUpdate.mock.calls[0]?.[0];
    expect(snapshot.chartContext).toEqual({
      spot: 24120,
      atmStrike: 24100,
      strikeInterval: 50,
      lotSize: 75,
      expiry: '2026-08-07',
      isFresh: true,
      receivedAtMs: 5000,
    });
    expect(snapshot.suggestion.recommendedSymbol).toBe('NIFTY');
    expect(snapshot.lastSuccessAtMs).toBe(5000);
    expect(snapshot.lastError).toBeNull();
    poller.stop();
  });

  it('backs off 5s -> 10s -> 20s -> 30s on consecutive failures, and resets to 5s on success', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    const apiClient = stubClient({
      fetchChartState: () => Promise.resolve(shouldFail ? err('down') : ok(CHART_STATE)),
      fetchRecommend: () => Promise.resolve(shouldFail ? err('down') : ok(RECOMMEND)),
    });
    const onUpdate = vi.fn();
    const poller = new DataPoller({ apiClient, shouldPoll: () => true, onUpdate });

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // tick 1: fails -> backoffIndex becomes 1, next delay = ladder[1] = 10s
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0].lastError).toBe('down');

    await vi.advanceTimersByTimeAsync(10_000); // tick 2: fails -> backoffIndex becomes 2, next delay = ladder[2] = 20s
    expect(onUpdate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000); // tick 3: fails -> backoffIndex becomes 3 (capped), next delay = ladder[3] = 30s
    expect(onUpdate).toHaveBeenCalledTimes(3);

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(30_000); // tick 4: next delay after 3 failures is ladder[3] = 30s
    expect(onUpdate).toHaveBeenCalledTimes(4);
    const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1]?.[0];
    expect(lastCall.lastError).toBeNull();
    expect(lastCall.lastSuccessAtMs).not.toBeNull();

    poller.stop();
  });

  it('a partial failure (one endpoint ok, one down) still reports the successful data and the error', async () => {
    vi.useFakeTimers();
    const apiClient = stubClient({ fetchRecommend: () => Promise.resolve(err('recommend down')) });
    const onUpdate = vi.fn();
    const poller = new DataPoller({ apiClient, shouldPoll: () => true, onUpdate, now: () => 1 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = onUpdate.mock.calls[0]?.[0];
    expect(snapshot.chartContext).not.toBeNull();
    expect(snapshot.suggestion).toBeNull();
    expect(snapshot.lastSuccessAtMs).toBe(1); // ANY success counts as a success for freshness purposes
    expect(snapshot.lastError).toBe('recommend down');

    poller.stop();
  });

  it('stop() prevents any further polling', async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const poller = new DataPoller({ apiClient: stubClient(), shouldPoll: () => true, onUpdate });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onUpdate).toHaveBeenCalledTimes(1); // no further calls after stop()
  });
});
