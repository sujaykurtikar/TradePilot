/**
 * Migration scaffold (§P1), first actually exercised by v1 -> v2 (§7.7's
 * "widget hidden with a reason in the popup" needed a place to store that
 * reason — see schema.ts's StorageSchemaV2 doc comment).
 */

import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_STORAGE,
  type StorageSchema,
  type StorageSchemaV1,
  type StorageSchemaV2,
} from './schema';
import { getLogger } from '../../utils/logger';

const log = getLogger('storage:migrations');

type Migration = (input: unknown) => unknown;

function upgradeV1ToV2(input: unknown): StorageSchemaV2 {
  const v1 = input as StorageSchemaV1;
  return {
    version: 2,
    enabled: v1.enabled,
    widgetCollapsed: v1.widgetCollapsed,
    widgetOffsets: v1.widgetOffsets,
    widgetHiddenReason: null, // new field — no prior value to carry forward
  };
}

/** Keyed by the version a migration upgrades FROM. */
const MIGRATIONS: Record<number, Migration> = {
  1: upgradeV1ToV2,
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
    log.warn('stored schema version unrecognized — resetting to defaults', {
      found: currentVersion,
    });
    return DEFAULT_STORAGE;
  }

  return current as StorageSchema;
}
