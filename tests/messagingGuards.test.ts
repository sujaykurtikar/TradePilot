import { describe, it, expect } from 'vitest';
import {
  isDataUpdateMessage,
  isGetStatusRequest,
  isTabVisibilityMessage,
  isTradePilotRequest,
} from '../src/core/messaging/guards';
import { EMPTY_MARKET_DATA_SNAPSHOT } from '../src/core/api/types';

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
});
