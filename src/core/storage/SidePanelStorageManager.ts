/** Thin wrapper over chrome.storage.local for the side panel's broker/strategy data — see sidePanelSchema.ts. */

import { getLogger } from '../../utils/logger';
import {
  DEFAULT_SIDEPANEL_STORAGE,
  migrateSidePanelStorage,
  SIDEPANEL_STORAGE_KEY,
  type SidePanelSchema,
} from './sidePanelSchema';

const log = getLogger('storage:sidepanel');

export class SidePanelStorageManager {
  async load(): Promise<SidePanelSchema> {
    try {
      const result = await chrome.storage.local.get(SIDEPANEL_STORAGE_KEY);
      return migrateSidePanelStorage(result[SIDEPANEL_STORAGE_KEY]);
    } catch (error) {
      log.error('storage read failed — using defaults', { error: String(error) });
      return DEFAULT_SIDEPANEL_STORAGE;
    }
  }

  async save(state: SidePanelSchema): Promise<void> {
    try {
      await chrome.storage.local.set({ [SIDEPANEL_STORAGE_KEY]: state });
    } catch (error) {
      log.error('storage write failed', { error: String(error) });
    }
  }

  async patch(patch: Partial<SidePanelSchema>): Promise<SidePanelSchema> {
    const current = await this.load();
    const next = { ...current, ...patch } as SidePanelSchema;
    await this.save(next);
    return next;
  }

  onChange(cb: (next: SidePanelSchema) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') return;
      const change = changes[SIDEPANEL_STORAGE_KEY];
      if (change === undefined) return;
      cb(migrateSidePanelStorage(change.newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
}
