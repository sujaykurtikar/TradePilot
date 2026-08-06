/**
 * Thin wrapper over chrome.storage.local for TradePilot's one settings
 * blob (§P1). Runs stored data through migrateStorage on every read so a
 * corrupt or outdated value never reaches a caller as-is.
 */

import { migrateStorage } from './migrations';
import { DEFAULT_STORAGE, STORAGE_KEY, type StorageSchema } from './schema';
import { getLogger } from '../../utils/logger';

const log = getLogger('storage:manager');

export class StorageManager {
  async load(): Promise<StorageSchema> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return migrateStorage(result[STORAGE_KEY]);
    } catch (error) {
      log.error('storage read failed — using defaults', { error: String(error) });
      return DEFAULT_STORAGE;
    }
  }

  async save(state: StorageSchema): Promise<void> {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } catch (error) {
      log.error('storage write failed', { error: String(error) });
    }
  }

  async patch(patch: Partial<StorageSchema>): Promise<StorageSchema> {
    const current = await this.load();
    const next = { ...current, ...patch } as StorageSchema;
    await this.save(next);
    return next;
  }

  /** Fires on ANY change to our key, from ANY context (popup, content, background) — keeps them in sync. */
  onChange(cb: (next: StorageSchema) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (change === undefined) return;
      cb(migrateStorage(change.newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
}
