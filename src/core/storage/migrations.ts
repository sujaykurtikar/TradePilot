/**
 * Migration scaffold (§P1). Only version 1 exists today, so this runs
 * zero migrations in practice — it exists so the NEXT schema change has
 * somewhere to go instead of a hand-rolled one-off in StorageManager.
 */

import { CURRENT_SCHEMA_VERSION, DEFAULT_STORAGE, type StorageSchema } from './schema';
import { getLogger } from '../../utils/logger';

const log = getLogger('storage:migrations');

type Migration = (input: unknown) => unknown;

/** Keyed by the version a migration upgrades FROM. */
const MIGRATIONS: Record<number, Migration> = {
  // 1: (v1) => upgradeToV2(v1),  <- example shape for the next migration
};

/** Best-effort: unknown/corrupt input falls back to defaults rather than throwing (§7.1/§7.2). */
export function migrateStorage(raw: unknown): StorageSchema {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return DEFAULT_STORAGE;
  }

  let current: unknown = raw;
  let currentVersion = (current as { version?: unknown }).version;

  while (typeof currentVersion === 'number' && currentVersion < CURRENT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[currentVersion];
    if (migrate === undefined) {
      log.error('no migration registered for stored version — resetting to defaults', {
        storedVersion: currentVersion,
      });
      return DEFAULT_STORAGE;
    }
    current = migrate(current);
    currentVersion = (current as { version?: unknown }).version;
  }

  if (currentVersion !== CURRENT_SCHEMA_VERSION) {
    log.warn('stored schema version unrecognized — resetting to defaults', { found: currentVersion });
    return DEFAULT_STORAGE;
  }

  return current as StorageSchema;
}
