/**
 * Client for the TradePilotBackend FastAPI service (separate, fully
 * isolated repo — see IMPLEMENTATION_PLAN_BACKEND_INTEGRATION.md). Base
 * URL defaults to localhost since no production deployment exists yet
 * (plan §2 decision 2: local-only for now). This module never falls back
 * to quantboard-pandapath or any other backend — if this one is
 * unreachable, callers fall back to the local mock catalog instead
 * (strategyCatalog.ts), never to a different real backend.
 */

import { getLogger } from '../../utils/logger';

const log = getLogger('api:strategy-backend');

const DEFAULT_BASE_URL = 'http://localhost:8100';
const REQUEST_TIMEOUT_MS = 3000;

export interface BackendStrategyCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly needs_option_chain: boolean;
}

export interface BackendSignal {
  readonly strategy_id: string;
  readonly symbol: string;
  readonly direction: 'long' | 'short' | 'neutral';
  readonly strike: number | null;
  readonly option_type: 'CE' | 'PE' | null;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly confidence: number;
  readonly rationale: string;
}

interface Envelope<T> {
  readonly data: T;
  readonly error: string | null;
}

async function get<T>(path: string, baseUrl: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Envelope<T>;
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

export class StrategyBackendClient {
  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {}

  /** Resolves null (never throws) on any network/timeout/HTTP failure — callers must fall back to mock data. */
  async fetchCatalog(): Promise<readonly BackendStrategyCatalogEntry[] | null> {
    try {
      return await get<BackendStrategyCatalogEntry[]>('/strategies/catalog', this.baseUrl);
    } catch (error) {
      log.warn('backend unreachable — caller should fall back to mock catalog', { error: String(error) });
      return null;
    }
  }

  async fetchSignal(strategyId: string, symbol: string): Promise<BackendSignal | null> {
    try {
      return await get<BackendSignal>(
        `/strategies/${encodeURIComponent(strategyId)}/signal?symbol=${encodeURIComponent(symbol)}`,
        this.baseUrl,
      );
    } catch (error) {
      log.warn('signal fetch failed', { strategyId, error: String(error) });
      return null;
    }
  }

  async fetchPerformance(strategyId: string): Promise<Record<string, unknown> | null> {
    try {
      return await get<Record<string, unknown>>(`/strategies/${encodeURIComponent(strategyId)}/performance`, this.baseUrl);
    } catch (error) {
      log.warn('performance fetch failed', { strategyId, error: String(error) });
      return null;
    }
  }
}

export const strategyBackendClient = new StrategyBackendClient();
