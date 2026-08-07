/**
 * Mock strategy catalog (Phase 3 plan §5.2). Local, clearly-commented,
 * not user-editable — seeded once, matching the reference screenshots'
 * "All strategies (16)" count. `fetchStrategyCatalog()` is the seam: swap
 * this implementation for a real backend call later (e.g. TradePilotBackend's
 * GET /strategies/catalog) without touching any UI code that calls it.
 */

import type { StrategyV2 } from '../storage/sidePanelSchema';

type MockCatalogEntry = Omit<StrategyV2, 'id' | 'createdAt' | 'notes' | 'favorite' | 'alertsEnabled'>;

const MOCK_ENTRIES: readonly MockCatalogEntry[] = [
  { name: 'SwingKing Sniper', instrument: 'NIFTY', winRatePct: 67, lastWeekDaily: ['win', 'loss', 'win', 'win', 'loss'], todayReturnsPct: 22.97 },
  { name: 'Traffic Light', instrument: 'NIFTY', winRatePct: 17, lastWeekDaily: ['loss', 'loss', 'win', 'loss', 'loss'], todayReturnsPct: -4.12 },
  { name: 'Reversal Catch', instrument: 'NIFTY', winRatePct: 75, lastWeekDaily: ['win', 'loss', 'win', 'win', 'win'], todayReturnsPct: 20.64 },
  { name: 'EMA Cross', instrument: 'NIFTY', winRatePct: 47, lastWeekDaily: ['loss', 'win', 'win', 'loss', 'win'], todayReturnsPct: 6.47 },
  { name: 'Confluence Core', instrument: 'NIFTY', winRatePct: 58, lastWeekDaily: ['win', 'win', 'loss', 'win', 'loss'], todayReturnsPct: 3.1 },
  { name: 'ORB Option Buy', instrument: 'NIFTY', winRatePct: 52, lastWeekDaily: ['win', 'loss', 'loss', 'win', 'win'], todayReturnsPct: -1.8 },
  { name: 'OI/PCR Directional', instrument: 'NIFTY', winRatePct: 61, lastWeekDaily: ['win', 'win', 'win', 'loss', 'win'], todayReturnsPct: 9.4 },
  { name: 'IV-Aware Momentum', instrument: 'NIFTY', winRatePct: 55, lastWeekDaily: ['loss', 'win', 'loss', 'win', 'win'], todayReturnsPct: 2.2 },
  { name: 'Max Pain Magnet', instrument: 'BANKNIFTY', winRatePct: 49, lastWeekDaily: ['win', 'loss', 'win', 'loss', 'loss'], todayReturnsPct: -3.5 },
  { name: 'Expiry Pin Fade', instrument: 'BANKNIFTY', winRatePct: 44, lastWeekDaily: ['loss', 'loss', 'win', 'loss', 'win'], todayReturnsPct: 1.1 },
  { name: 'ORB + Flow Scalp', instrument: 'BANKNIFTY', winRatePct: 38, lastWeekDaily: ['loss', 'win', 'loss', 'loss', 'win'], todayReturnsPct: -6.9 },
  { name: 'Gap Fade Pro', instrument: 'BANKNIFTY', winRatePct: 63, lastWeekDaily: ['win', 'win', 'loss', 'win', 'win'], todayReturnsPct: 11.3 },
  { name: 'VWAP Bounce', instrument: 'NIFTY', winRatePct: 71, lastWeekDaily: ['win', 'win', 'win', 'loss', 'win'], todayReturnsPct: 15.6 },
  { name: 'Breakout Hunter', instrument: 'SENSEX', winRatePct: 29, lastWeekDaily: ['loss', 'loss', 'loss', 'win', 'loss'], todayReturnsPct: -9.2 },
  { name: 'Range Scalper', instrument: 'SENSEX', winRatePct: 54, lastWeekDaily: ['win', 'loss', 'win', 'loss', 'win'], todayReturnsPct: 4.4 },
  { name: 'Trend Rider', instrument: 'SENSEX', winRatePct: 66, lastWeekDaily: ['win', 'win', 'loss', 'win', 'win'], todayReturnsPct: 18.0 },
];

/**
 * Deterministic slug ids so applying/removing survives a re-fetch without
 * generating a new id each time (matters once P11 wires Apply against this).
 */
function slugId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function fetchStrategyCatalog(): readonly StrategyV2[] {
  return MOCK_ENTRIES.map((entry) => ({
    ...entry,
    id: slugId(entry.name),
    notes: '',
    createdAt: Date.now(),
    favorite: false,
    alertsEnabled: false,
  }));
}
