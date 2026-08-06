import { describe, it, expect } from 'vitest';
import {
  isDataUpdateMessage,
  isGetStatusRequest,
  isPlaceOrderRequest,
  isPositionRiskRequest,
  isTabVisibilityMessage,
  isTradePilotRequest,
} from '../src/core/messaging/guards';
import { EMPTY_MARKET_DATA_SNAPSHOT } from '../src/core/api/types';

const VALID_PLACE_ORDER = {
  type: 'tradepilot/place-order',
  clientOrderId: 'order-1',
  direction: 'BUY',
  lots: 1,
  strike: 24100,
  optionType: 'CE',
  sl: 24050,
  tp: 24150,
  paperMode: true,
};

const VALID_POSITION_RISK = {
  type: 'tradepilot/position-risk',
  requestId: 'req-1',
  positionId: 'pos-1',
  account: 'acct-1',
  sl: 24050,
};

describe('message guards — §7.1 "a guard, not a cast"', () => {
  it('accepts a well-formed get-status request', () => {
    expect(isGetStatusRequest({ type: 'tradepilot/get-status' })).toBe(true);
    expect(isTradePilotRequest({ type: 'tradepilot/get-status' })).toBe(true);
  });

  it('rejects unrelated payloads that happen to be objects', () => {
    expect(isGetStatusRequest({ type: 'some-other-extensions-message' })).toBe(false);
    expect(isTradePilotRequest({ foo: 'bar' })).toBe(false);
  });

  it('rejects non-objects without throwing', () => {
    expect(isGetStatusRequest(null)).toBe(false);
    expect(isGetStatusRequest(undefined)).toBe(false);
    expect(isGetStatusRequest('tradepilot/get-status')).toBe(false);
    expect(isGetStatusRequest(42)).toBe(false);
  });

  it('isTabVisibilityMessage accepts a well-formed message and rejects a missing/wrong-typed `visible`', () => {
    expect(isTabVisibilityMessage({ type: 'tradepilot/tab-visibility', visible: true })).toBe(true);
    expect(isTabVisibilityMessage({ type: 'tradepilot/tab-visibility' })).toBe(false);
    expect(isTabVisibilityMessage({ type: 'tradepilot/tab-visibility', visible: 'yes' })).toBe(
      false,
    );
    expect(isTradePilotRequest({ type: 'tradepilot/tab-visibility', visible: false })).toBe(true);
  });

  it('isDataUpdateMessage accepts a well-formed push and rejects a missing/malformed snapshot', () => {
    expect(
      isDataUpdateMessage({ type: 'tradepilot/data-update', snapshot: EMPTY_MARKET_DATA_SNAPSHOT }),
    ).toBe(true);
    expect(isDataUpdateMessage({ type: 'tradepilot/data-update' })).toBe(false);
    expect(isDataUpdateMessage({ type: 'tradepilot/data-update', snapshot: 'nope' })).toBe(false);
  });

  describe('isPlaceOrderRequest — §R-P6, the order-submission path', () => {
    it('accepts a well-formed request', () => {
      expect(isPlaceOrderRequest(VALID_PLACE_ORDER)).toBe(true);
      expect(isTradePilotRequest(VALID_PLACE_ORDER)).toBe(true);
    });

    it('accepts nullable sl/tp', () => {
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, sl: null, tp: null })).toBe(true);
    });

    it('rejects a missing or empty clientOrderId', () => {
      const { clientOrderId: _drop, ...rest } = VALID_PLACE_ORDER;
      expect(isPlaceOrderRequest(rest)).toBe(false);
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, clientOrderId: '' })).toBe(false);
    });

    it('rejects an invalid direction or optionType', () => {
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, direction: 'HOLD' })).toBe(false);
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, optionType: 'XX' })).toBe(false);
    });

    it('rejects non-positive or non-finite lots', () => {
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, lots: 0 })).toBe(false);
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, lots: -1 })).toBe(false);
      expect(isPlaceOrderRequest({ ...VALID_PLACE_ORDER, lots: NaN })).toBe(false);
    });

    it('rejects a missing paperMode flag', () => {
      const { paperMode: _drop, ...rest } = VALID_PLACE_ORDER;
      expect(isPlaceOrderRequest(rest)).toBe(false);
    });
  });

  describe('isPositionRiskRequest — §P6t/§R-P6t', () => {
    it('accepts a well-formed request with only sl', () => {
      expect(isPositionRiskRequest(VALID_POSITION_RISK)).toBe(true);
      expect(isTradePilotRequest(VALID_POSITION_RISK)).toBe(true);
    });

    it('accepts a well-formed request with only tp', () => {
      const { sl: _drop, ...rest } = VALID_POSITION_RISK;
      expect(isPositionRiskRequest({ ...rest, tp: 24200 })).toBe(true);
    });

    it('rejects a request with NEITHER sl nor tp — nothing would actually change', () => {
      const { sl: _drop, ...rest } = VALID_POSITION_RISK;
      expect(isPositionRiskRequest(rest)).toBe(false);
    });

    it('rejects a non-finite sl/tp (NaN must never reach the network, §7.1)', () => {
      expect(isPositionRiskRequest({ ...VALID_POSITION_RISK, sl: NaN })).toBe(false);
    });

    it('rejects a missing requestId, positionId, or account', () => {
      const { requestId: _drop, ...rest } = VALID_POSITION_RISK;
      expect(isPositionRiskRequest(rest)).toBe(false);
      expect(isPositionRiskRequest({ ...VALID_POSITION_RISK, positionId: '' })).toBe(false);
      expect(isPositionRiskRequest({ ...VALID_POSITION_RISK, account: '' })).toBe(false);
    });
  });
});
