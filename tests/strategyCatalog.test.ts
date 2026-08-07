import { describe, it, expect } from 'vitest';
import { fetchStrategyCatalog } from '../src/core/strategies/strategyCatalog';

describe('fetchStrategyCatalog (mock, P9 §5.2 seam)', () => {
  it('returns 16 strategies, matching the reference screenshots\' "All strategies (16)"', () => {
    expect(fetchStrategyCatalog()).toHaveLength(16);
  });

  it('every entry has a unique, non-empty, slug-shaped id', () => {
    const catalog = fetchStrategyCatalog();
    const ids = catalog.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('every entry has a valid win rate and a 5-day lastWeekDaily array of only win/loss', () => {
    for (const strategy of fetchStrategyCatalog()) {
      expect(strategy.winRatePct).toBeGreaterThanOrEqual(0);
      expect(strategy.winRatePct).toBeLessThanOrEqual(100);
      expect(strategy.lastWeekDaily).toHaveLength(5);
      for (const day of strategy.lastWeekDaily) {
        expect(['win', 'loss']).toContain(day);
      }
    }
  });

  it('ids for the 7 strategies also implemented by TradePilotBackend normalize to match the backend\'s underscored ids', () => {
    // Mirrors the normalizeId() logic in sidepanel.ts (hyphen -> underscore)
    // used to tag cards "Live" vs "Mock" — this test guards against either
    // side silently renaming a strategy and breaking that match.
    const backendIds = new Set([
      'confluence_core',
      'orb_option_buy',
      'oi_pcr_directional',
      'iv_aware_momentum',
      'max_pain_magnet',
      'expiry_pin_fade',
      'orb_flow_scalp',
    ]);
    const catalog = fetchStrategyCatalog();
    const normalizedMockIds = new Set(catalog.map((s) => s.id.replace(/-/g, '_')));
    for (const backendId of backendIds) {
      expect(normalizedMockIds.has(backendId)).toBe(true);
    }
  });

  it('is deterministic across calls within the same process (stable ids for repeated Apply/Remove)', () => {
    const first = fetchStrategyCatalog().map((s) => s.id);
    const second = fetchStrategyCatalog().map((s) => s.id);
    expect(second).toEqual(first);
  });
});
