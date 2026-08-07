import { describe, it, expect } from 'vitest';
import {
  migrateSidePanelStorage,
  DEFAULT_SIDEPANEL_STORAGE,
  type Strategy,
} from '../src/core/storage/sidePanelSchema';

describe('migrateSidePanelStorage — must never throw on bad input (mirrors §7.1/§7.2 for the widget schema)', () => {
  it('returns defaults for undefined (nothing stored yet)', () => {
    expect(migrateSidePanelStorage(undefined)).toEqual(DEFAULT_SIDEPANEL_STORAGE);
  });

  it('returns defaults for null', () => {
    expect(migrateSidePanelStorage(null)).toEqual(DEFAULT_SIDEPANEL_STORAGE);
  });

  it('returns defaults for a non-object (corrupt storage)', () => {
    expect(migrateSidePanelStorage('garbage')).toEqual(DEFAULT_SIDEPANEL_STORAGE);
    expect(migrateSidePanelStorage(42)).toEqual(DEFAULT_SIDEPANEL_STORAGE);
  });

  it('resets to defaults for an unrecognized future version with no migration path', () => {
    const fromTheFuture = { version: 99, brokers: {} };
    expect(migrateSidePanelStorage(fromTheFuture)).toEqual(DEFAULT_SIDEPANEL_STORAGE);
  });

  it('passes a valid current-version (v2) record through unchanged', () => {
    const valid = {
      version: 2 as const,
      brokers: {},
      strategies: [],
      appliedStrategyIds: ['confluence-core'],
      activeStrategyId: 'confluence-core',
      strategiesLoggedIn: true,
    };
    expect(migrateSidePanelStorage(valid)).toEqual(valid);
  });

  it('fills in missing v2 fields (e.g. from a v2 record written by an older build) with safe defaults', () => {
    const partialV2 = { version: 2 as const, brokers: {} };
    expect(migrateSidePanelStorage(partialV2)).toEqual({
      version: 2,
      brokers: {},
      strategies: [],
      appliedStrategyIds: [],
      activeStrategyId: null,
      strategiesLoggedIn: false,
    });
  });

  it('migrates a real v1 record to v2 — existing strategies default-filled, nothing applied (manual mode preserved)', () => {
    const v1Strategy: Strategy = {
      id: 'abc123',
      name: 'My Opening Range Rule',
      notes: 'Enter on first 5m breakout',
      createdAt: 1700000000000,
    };
    const storedV1 = {
      version: 1 as const,
      brokers: { dhan: { id: 'dhan', name: 'Dhan', apiKey: 'k', apiSecret: 's', connectedAt: 1 } },
      strategies: [v1Strategy],
    };

    const migrated = migrateSidePanelStorage(storedV1);

    expect(migrated.version).toBe(2);
    expect(migrated.brokers).toEqual(storedV1.brokers);
    // Zero applied on upgrade — every existing install lands in manual mode
    // until the user explicitly applies a strategy (plan §5.1 migration note).
    expect(migrated.appliedStrategyIds).toEqual([]);
    expect(migrated.activeStrategyId).toBeNull();
    expect(migrated.strategiesLoggedIn).toBe(false);

    expect(migrated.strategies).toHaveLength(1);
    const upgraded = migrated.strategies[0];
    if (upgraded === undefined) throw new Error('expected exactly one migrated strategy');
    // Original v1 fields preserved unchanged.
    expect(upgraded.id).toBe(v1Strategy.id);
    expect(upgraded.name).toBe(v1Strategy.name);
    expect(upgraded.notes).toBe(v1Strategy.notes);
    expect(upgraded.createdAt).toBe(v1Strategy.createdAt);
    // New v2 fields default-filled, not left undefined.
    expect(upgraded.instrument).toBe('NIFTY');
    expect(upgraded.winRatePct).toBe(0);
    expect(upgraded.lastWeekDaily).toEqual([]);
    expect(upgraded.todayReturnsPct).toBe(0);
    expect(upgraded.favorite).toBe(false);
    expect(upgraded.alertsEnabled).toBe(false);
  });

  it('migrates a v1 record with zero strategies cleanly (most common real-world case)', () => {
    const storedV1 = { version: 1 as const, brokers: {}, strategies: [] };
    expect(migrateSidePanelStorage(storedV1)).toEqual({
      version: 2,
      brokers: {},
      strategies: [],
      appliedStrategyIds: [],
      activeStrategyId: null,
      strategiesLoggedIn: false,
    });
  });
});
