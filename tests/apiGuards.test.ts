import { describe, it, expect } from 'vitest';
import { isRawChartState, isRawPosition, isRawRecommend } from '../src/core/api/guards';

const VALID_POSITION = {
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

const VALID_CHART_STATE = {
  spot: 24120.5,
  atm_strike: 24100,
  strike_interval: 50,
  lot_size: 75,
  expiry: '2026-08-07',
  is_fresh: true,
  positions: [VALID_POSITION],
};

const VALID_RECOMMEND = {
  direction: 'BUY',
  recommended_symbol: 'NIFTY',
  recommended_option_type: 'CE',
  recommended_ltp: 145.5,
  sl: 130,
  tp: 180,
  composite_score: 0.82,
  rationale: ['OI buildup', 'above VWAP'],
};

describe('isRawPosition', () => {
  it('accepts a well-formed position', () => {
    expect(isRawPosition(VALID_POSITION)).toBe(true);
  });

  it('accepts nullable numeric fields as null (backend Optional[float])', () => {
    expect(
      isRawPosition({ ...VALID_POSITION, sl: null, tp: null, delta: null, unrealized_pnl: null }),
    ).toBe(true);
  });

  it('rejects NaN in a numeric field', () => {
    expect(isRawPosition({ ...VALID_POSITION, sl: NaN })).toBe(false);
  });

  it('rejects a missing required string field', () => {
    const { position_id: _drop, ...rest } = VALID_POSITION;
    expect(isRawPosition(rest)).toBe(false);
  });

  it('rejects an invalid option_type', () => {
    expect(isRawPosition({ ...VALID_POSITION, option_type: 'XX' })).toBe(false);
  });
});

describe('isRawChartState', () => {
  it('accepts a well-formed chart state', () => {
    expect(isRawChartState(VALID_CHART_STATE)).toBe(true);
  });

  it('accepts null spot/atm_strike/etc (fields the backend types Optional)', () => {
    expect(
      isRawChartState({
        ...VALID_CHART_STATE,
        spot: null,
        atm_strike: null,
        strike_interval: null,
        lot_size: null,
        expiry: null,
      }),
    ).toBe(true);
  });

  it('rejects a non-array positions field', () => {
    expect(isRawChartState({ ...VALID_CHART_STATE, positions: 'nope' })).toBe(false);
  });

  it('rejects if any position in the array is malformed', () => {
    expect(isRawChartState({ ...VALID_CHART_STATE, positions: [{ bad: true }] })).toBe(false);
  });

  it('rejects a non-boolean is_fresh', () => {
    expect(isRawChartState({ ...VALID_CHART_STATE, is_fresh: 'yes' })).toBe(false);
  });

  it('rejects non-objects and null entirely', () => {
    expect(isRawChartState(null)).toBe(false);
    expect(isRawChartState('garbage')).toBe(false);
    expect(isRawChartState(undefined)).toBe(false);
  });
});

describe('isRawRecommend', () => {
  it('accepts a well-formed recommendation', () => {
    expect(isRawRecommend(VALID_RECOMMEND)).toBe(true);
  });

  it('accepts sl/tp/composite_score/recommended_ltp as null', () => {
    expect(
      isRawRecommend({
        ...VALID_RECOMMEND,
        sl: null,
        tp: null,
        composite_score: null,
        recommended_ltp: null,
      }),
    ).toBe(true);
  });

  it('rejects an invalid direction', () => {
    expect(isRawRecommend({ ...VALID_RECOMMEND, direction: 'HOLD' })).toBe(false);
  });

  it('rejects a non-string-array rationale', () => {
    expect(isRawRecommend({ ...VALID_RECOMMEND, rationale: ['ok', 42] })).toBe(false);
  });
});
