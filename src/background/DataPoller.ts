/**
 * Owns the poll loop for our two read endpoints (§P5/§R-P5). Runs
 * strictly sequentially — the next tick is only scheduled once both of
 * this tick's requests have settled — which structurally guarantees
 * "single in-flight request per endpoint" without needing to explicitly
 * abort a previous cycle's request (there never IS a previous cycle's
 * request still running when a new one starts). What sequencing alone
 * doesn't protect against is a single request hanging forever, so each
 * request still gets its own AbortController with a hard timeout —
 * "never hammer a dead API for an hour" cuts both ways: also don't let
 * one slow request block the whole loop for an hour.
 *
 * Backoff: 5s -> 10s -> 20s -> 30s cap, reset on first success (§R-P5).
 * Gating (visibility + market hours) is injected via `shouldPoll` rather
 * than known here — this class doesn't need to know WHY it's paused.
 */

import { mapChartState, mapPositions, mapRecommend } from '../core/api/mappers';
import type { RawChartState, RawRecommend } from '../core/api/types';
import { EMPTY_MARKET_DATA_SNAPSHOT, type MarketDataSnapshot } from '../core/api/types';
import type { Result } from '../utils/result';
import { getLogger } from '../utils/logger';

const log = getLogger('background:data-poller');

const BACKOFF_LADDER_MS = [5_000, 10_000, 20_000, 30_000] as const;
const IDLE_RECHECK_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;

function backoffDelayMs(index: number): number {
  const clamped = Math.min(Math.max(index, 0), BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[clamped] ?? 30_000; // 30_000 = the ladder's own final rung; only a fallback for the type checker
}

/** The only shape DataPoller actually needs from ApiClient — narrower than the full class, which keeps this trivially testable with a stub (same pattern as CapabilityProbe's ProbeCapableBridge). */
export interface PollableApiClient {
  fetchChartState(signal: AbortSignal): Promise<Result<RawChartState, string>>;
  fetchRecommend(signal: AbortSignal): Promise<Result<RawRecommend, string>>;
}

export interface DataPollerDeps {
  readonly apiClient: PollableApiClient;
  readonly shouldPoll: () => boolean;
  readonly onUpdate: (snapshot: MarketDataSnapshot) => void;
  /** injectable for tests; defaults to Date.now */
  readonly now?: () => number;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortController {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  });
  return controller;
}

export class DataPoller {
  private readonly deps: DataPollerDeps;
  private snapshot: MarketDataSnapshot = EMPTY_MARKET_DATA_SNAPSHOT;
  private backoffIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlightAbort: AbortController | null = null;

  constructor(deps: DataPollerDeps) {
    this.deps = deps;
  }

  getSnapshot(): MarketDataSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlightAbort?.abort();
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick().catch((error: unknown) =>
        log.error('poll tick threw unexpectedly', { error: String(error) }),
      );
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (!this.deps.shouldPoll()) {
      this.scheduleNext(IDLE_RECHECK_MS);
      return;
    }

    const controller = withTimeout(undefined, REQUEST_TIMEOUT_MS);
    this.inFlightAbort = controller;
    const now = (this.deps.now ?? Date.now)();

    const [chartResult, recommendResult] = await Promise.all([
      this.deps.apiClient.fetchChartState(controller.signal),
      this.deps.apiClient.fetchRecommend(controller.signal),
    ]);
    this.inFlightAbort = null;
    if (!this.running) return; // stopped while the requests were in flight

    let next = this.snapshot;
    let anySuccess = false;
    let lastError: string | null = null;

    if (chartResult.ok) {
      anySuccess = true;
      next = {
        ...next,
        chartContext: mapChartState(chartResult.value, now),
        positions: mapPositions(chartResult.value),
      };
    } else {
      lastError = chartResult.error;
      log.debug('chart/state poll failed', { error: chartResult.error });
    }

    if (recommendResult.ok) {
      anySuccess = true;
      next = { ...next, suggestion: mapRecommend(recommendResult.value, now) };
    } else {
      lastError = recommendResult.error;
      log.debug('recommend poll failed', { error: recommendResult.error });
    }

    if (anySuccess) {
      this.backoffIndex = 0;
      next = {
        ...next,
        lastSuccessAtMs: now,
        lastError: chartResult.ok && recommendResult.ok ? null : lastError,
      };
    } else {
      this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_LADDER_MS.length - 1);
      next = { ...next, lastError };
    }

    this.snapshot = next;
    this.deps.onUpdate(next);

    const delay = anySuccess ? backoffDelayMs(0) : backoffDelayMs(this.backoffIndex);
    this.scheduleNext(delay);
  }
}
