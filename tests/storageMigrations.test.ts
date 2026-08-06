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

  it('passes a valid current-version record through unchanged', () => {
    const valid = {
      version: 1 as const,
      enabled: false,
      widgetCollapsed: true,
      widgetOffsets: { 'level-pill-tp': { dx: 5, dy: -3 } },
    };
    expect(migrateStorage(valid)).toEqual(valid);
  });

  it('resets to defaults for an unrecognized future version with no migration path', () => {
    const fromTheFuture = { version: 99, enabled: true };
    expect(migrateStorage(fromTheFuture)).toEqual(DEFAULT_STORAGE);
  });
});
