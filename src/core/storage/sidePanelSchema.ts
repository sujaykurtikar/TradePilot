/**
 * chrome.storage.local schema for the side panel (broker connections +
 * strategies). Kept as its own key/manager rather than folded into
 * StorageSchema (schema.ts) — that schema is the widget's versioned
 * settings blob; this is unrelated data with its own shape, and giving it
 * a separate key avoids coupling a migration bump here to one there.
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

export interface SidePanelSchema {
  readonly version: 1;
  readonly brokers: Readonly<Record<string, BrokerConnection>>;
  readonly strategies: readonly Strategy[];
}

export const DEFAULT_SIDEPANEL_STORAGE: SidePanelSchema = {
  version: 1,
  brokers: {},
  strategies: [],
};

export const SIDEPANEL_STORAGE_KEY = 'tradepilot_sidepanel';

export function migrateSidePanelStorage(raw: unknown): SidePanelSchema {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return DEFAULT_SIDEPANEL_STORAGE;
  }
  const candidate = raw as Partial<SidePanelSchema>;
  if (candidate.version !== 1) return DEFAULT_SIDEPANEL_STORAGE;
  return {
    version: 1,
    brokers: candidate.brokers ?? {},
    strategies: candidate.strategies ?? [],
  };
}
