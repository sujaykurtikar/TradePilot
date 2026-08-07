/**
 * Raw fetch + type-guard wrapper over our backend's two read endpoints
 * (§2). Pure and unit-testable — no chrome.* dependency of its own; the
 * guard/type logic it depends on lives in core/api/** since that part
 * has no chrome-specific concerns either.
 *
 * §5.1: "All network. host_permissions bypass CORS for our API" — this
 * class is only ever meant to be instantiated from the service worker,
 * which is the one context whose fetches get that CORS bypass from
 * host_permissions.
 */

import { isRawChartState, isRawRecommend } from '../core/api/guards';
import type { RawChartState, RawRecommend } from '../core/api/types';
import { ok, err, type Result } from '../utils/result';

export interface ApiClientConfig {
  readonly baseUrl: string;
}

async function fetchGuarded<T>(
  url: string,
  guard: (value: unknown) => value is T,
  signal: AbortSignal,
): Promise<Result<T, string>> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) return err('request aborted');
    return err(`network error: ${String(error)}`);
  }
  if (!response.ok) {
    return err(`HTTP ${response.status}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    return err(`invalid JSON: ${String(error)}`);
  }
  if (!guard(json)) {
    return err('response failed shape validation');
  }
  return ok(json);
}

export class ApiClient {
  private readonly baseUrl: string;
  /**
   * Which strategy's own logic should compute /recommend's signal, kept by
   * the side panel's "applied strategies" (chrome.storage) via
   * background/index.ts's subscription — null means the backend's own
   * default strategy (today's behavior, unchanged for anyone who's never
   * applied one). Backend-facing ids only (underscores) — normalizing
   * from the extension's own mock ids is the caller's job, same as
   * sidepanel.ts already does for catalog matching.
   */
  private activeStrategyId: string | null = null;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  setActiveStrategyId(id: string | null): void {
    this.activeStrategyId = id;
  }

  fetchChartState(signal: AbortSignal): Promise<Result<RawChartState, string>> {
    return fetchGuarded(`${this.baseUrl}/chart/state`, isRawChartState, signal);
  }

  fetchRecommend(signal: AbortSignal): Promise<Result<RawRecommend, string>> {
    const strategyQuery =
      this.activeStrategyId !== null
        ? `?strategy_id=${encodeURIComponent(this.activeStrategyId)}`
        : '';
    return fetchGuarded(`${this.baseUrl}/recommend${strategyQuery}`, isRawRecommend, signal);
  }
}
