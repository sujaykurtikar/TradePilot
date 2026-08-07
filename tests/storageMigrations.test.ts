import { describe, it, expect } from 'vitest';
import { migrateStorage } from '../src/core/storage/migrations';
import { DEFAULT_STORAGE } from '../src/core/storage/schema';

describe('migrateStorage — must never throw on bad input (§7.1/§7.2)', () => {
  it('returns defaults for undefined (nothing stored yet)', () => {
    expect(migrateStorage(undefined)).toEqual(DEFAULT_STORAGE);
  });

  it('returns defaults for null', () => {
    expect(migrateStorage(null)).toEqual(DEFAULT_STORAGE);
  });

  it('returns defaults for a non-object (corrupt storage)', () => {
    expect(migrateStorage('garbage')).toEqual(DEFAULT_STORAGE);
    expect(migrateStorage(42)).toEqual(DEFAULT_STORAGE);
  });

  it('passes a valid current-version (v3) record through unchanged', () => {
    const valid = {
      version: 3 as const,
      enabled: false,
      widgetCollapsed: true,
      widgetOffsets: { 'level-pill-tp': { dx: 5, dy: -3 } },
      widgetHiddenReason: 'Symbol "XYZ" is not in the symbol map.',
      tradingMode: 'personal' as const,
    };
    expect(migrateStorage(valid)).toEqual(valid);
  });

  it('resets to defaults for an unrecognized future version with no migration path', () => {
    const fromTheFuture = { version: 99, enabled: true };
    expect(migrateStorage(fromTheFuture)).toEqual(DEFAULT_STORAGE);
  });

  it('migrates a real v1 record to v3 — the actual exercise of the migration scaffold (§P1)', () => {
    const storedV1 = {
      version: 1 as const,
      enabled: false,
      widgetCollapsed: true,
      widgetOffsets: { 'level-pill-sl': { dx: -2, dy: 4 } },
    };
    const migrated = migrateStorage(storedV1);
    expect(migrated).toEqual({
      version: 3,
      enabled: false,
      widgetCollapsed: true,
      widgetOffsets: { 'level-pill-sl': { dx: -2, dy: 4 } },
      widgetHiddenReason: null, // new field defaults to null — no v1 value to carry forward
      tradingMode: 'strategy', // new field defaults to 'strategy' — today's existing behavior
    });
  });

  it('migrates a v2 record to v3, defaulting tradingMode to "strategy" (today\'s existing behavior)', () => {
    const storedV2 = {
      version: 2 as const,
      enabled: true,
      widgetCollapsed: false,
      widgetOffsets: {},
      widgetHiddenReason: 'Symbol "ABC" is not in the symbol map.',
    };
    const migrated = migrateStorage(storedV2);
    expect(migrated).toEqual({
      version: 3,
      enabled: true,
      widgetCollapsed: false,
      widgetOffsets: {},
      widgetHiddenReason: 'Symbol "ABC" is not in the symbol map.',
      tradingMode: 'strategy',
    });
  });
});
