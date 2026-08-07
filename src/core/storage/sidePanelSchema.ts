/**
 * chrome.storage.local schema for the side panel (broker connections +
 * strategies). Kept as its own key/manager rather than folded into
 * StorageSchema (schema.ts) — that schema is the widget's versioned
 * settings blob; this is unrelated data with its own shape, and giving it
 * a separate key avoids coupling a migration bump here to one there.
 *
 * v2 (Phase 3 / IMPLEMENTATION_PLAN_STRATEGIES_SIGNALS.md §5.1): adds the
 * richer strategy model (win rate, last-week daily results, today's
 * returns, favorite/alerts) plus applied/active strategy tracking, which
 * on-chart trading mode is derived from (0 applied = manual, >=1 = strategy).
 */

export interface BrokerConnection {
  readonly id: string;
  readonly name: string;
  /** Never sent anywhere by this extension — chrome.storage.local only, read back to prefill the form. */
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly connectedAt: number;
}

export interface Strategy {
  readonly id: string;
  readonly name: string;
  readonly notes: string;
  readonly createdAt: number;
}

export interface StrategyV2 {
  readonly id: string;
  readonly name: string;
  readonly notes: string;
  readonly createdAt: number;
  readonly instrument: string;
  readonly winRatePct: number;
  readonly lastWeekDaily: readonly ('win' | 'loss')[];
  readonly todayReturnsPct: number;
  readonly favorite: boolean;
  readonly alertsEnabled: boolean;
}

export interface SidePanelSchema {
  readonly version: 1;
  readonly brokers: Readonly<Record<string, BrokerConnection>>;
  readonly strategies: readonly Strategy[];
}

export interface SidePanelSchemaV2 {
  readonly version: 2;
  readonly brokers: Readonly<Record<string, BrokerConnection>>;
  readonly strategies: readonly StrategyV2[];
  readonly appliedStrategyIds: readonly string[];
  readonly activeStrategyId: string | null;
  readonly strategiesLoggedIn: boolean;
}

export const DEFAULT_SIDEPANEL_STORAGE: SidePanelSchemaV2 = {
  version: 2,
  brokers: {},
  strategies: [],
  appliedStrategyIds: [],
  activeStrategyId: null,
  strategiesLoggedIn: false,
};

export const SIDEPANEL_STORAGE_KEY = 'tradepilot_sidepanel';

function upgradeStrategyV1ToV2(strategy: Strategy): StrategyV2 {
  return {
    ...strategy,
    instrument: 'NIFTY',
    winRatePct: 0,
    lastWeekDaily: [],
    todayReturnsPct: 0,
    favorite: false,
    alertsEnabled: false,
  };
}

export function migrateSidePanelStorage(raw: unknown): SidePanelSchemaV2 {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return DEFAULT_SIDEPANEL_STORAGE;
  }

  const candidate = raw as Partial<SidePanelSchema> | Partial<SidePanelSchemaV2>;

  if (candidate.version === 2) {
    return {
      version: 2,
      brokers: candidate.brokers ?? {},
      strategies: candidate.strategies ?? [],
      appliedStrategyIds: candidate.appliedStrategyIds ?? [],
      activeStrategyId: candidate.activeStrategyId ?? null,
      strategiesLoggedIn: candidate.strategiesLoggedIn ?? false,
    };
  }

  if (candidate.version === 1) {
    return {
      version: 2,
      brokers: candidate.brokers ?? {},
      strategies: (candidate.strategies ?? []).map(upgradeStrategyV1ToV2),
      // Preserves today's real behavior on upgrade: zero applied strategies
      // means every existing install lands in manual mode until the user
      // explicitly applies one (plan §5.1 migration note).
      appliedStrategyIds: [],
      activeStrategyId: null,
      strategiesLoggedIn: false,
    };
  }

  return DEFAULT_SIDEPANEL_STORAGE;
}
