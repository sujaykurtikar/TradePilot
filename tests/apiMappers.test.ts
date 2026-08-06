import { describe, it, expect } from 'vitest';
import { mapChartState, mapPosition, mapPositions, mapRecommend } from '../src/core/api/mappers';
import type { RawChartState, RawPosition, RawRecommend } from '../src/core/api/types';

const RAW_POSITION: RawPosition = {
  position_id: 'p1',
  account: 'acct-1',
  symbol: 'NIFTY',
  option_type: 'CE',
  strike: 24100,
  entry_spot: 24080,
  sl: 24050,
  tp: 24150,
  delta: 0.5,
  unrealized_pnl: 120.5,
};

describe('mapPosition', () => {
  it('converts snake_case wire fields to camelCase internal fields 1:1', () => {
    expect(mapPosition(RAW_POSITION)).toEqual({
      positionId: 'p1',
      account: 'acct-1',
      symbol: 'NIFTY',
      optionType: 'CE',
      strike: 24100,
      entrySpot: 24080,
      sl: 24050,
      tp: 24150,
      delta: 0.5,
      unrealizedPnl: 120.5,
    });
  });
});

describe('mapChartState / mapPositions', () => {
  const raw: RawChartState = {
    spot: 24120.5,
    atm_strike: 24100,
    strike_interval: 50,
    lot_size: 75,
    expiry: '2026-08-07',
    is_fresh: true,
    positions: [RAW_POSITION],
  };

  it('maps chart state fields and stamps the given timestamp', () => {
    expect(mapChartState(raw, 1000)).toEqual({
      spot: 24120.5,
      atmStrike: 24100,
      strikeInterval: 50,
      lotSize: 75,
      expiry: '2026-08-07',
      isFresh: true,
      receivedAtMs: 1000,
    });
  });

  it('null fields pass through as null — never coalesced (§7.1)', () => {
    const nulled: RawChartState = { ...raw, spot: null, atm_strike: null };
    const mapped = mapChartState(nulled, 1000);
    expect(mapped.spot).toBeNull();
    expect(mapped.atmStrike).toBeNull();
  });

  it('mapPositions maps every position in the array', () => {
    expect(mapPositions(raw)).toHaveLength(1);
    expect(mapPositions(raw)[0]?.positionId).toBe('p1');
  });
});

describe('mapRecommend', () => {
  const raw: RawRecommend = {
    direction: 'BUY',
    recommended_symbol: 'NIFTY',
    recommended_option_type: 'CE',
    recommended_ltp: 145.5,
    sl: 130,
    tp: 180,
    composite_score: 0.82,
    rationale: ['OI buildup'],
  };

  it('maps fields and stamps computedAtPrice from recommended_ltp', () => {
    const mapped = mapRecommend(raw, 2000);
    expect(mapped).toEqual({
      direction: 'BUY',
      recommendedSymbol: 'NIFTY',
      recommendedOptionType: 'CE',
      recommendedLtp: 145.5,
      sl: 130,
      tp: 180,
      compositeScore: 0.82,
      rationale: ['OI buildup'],
      computedAtPrice: 145.5,
      receivedAtMs: 2000,
    });
  });

  it('a null recommended_ltp propagates to computedAtPrice as null too', () => {
    const mapped = mapRecommend({ ...raw, recommended_ltp: null }, 2000);
    expect(mapped.recommendedLtp).toBeNull();
    expect(mapped.computedAtPrice).toBeNull();
  });
});
