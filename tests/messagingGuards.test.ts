import { describe, it, expect } from 'vitest';
import { isGetStatusRequest, isTradePilotRequest } from '../src/core/messaging/guards';

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
});
