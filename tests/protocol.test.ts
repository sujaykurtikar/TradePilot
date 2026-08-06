import { describe, it, expect } from 'vitest';
import { isProtocolMessage, readProtocolMessage, PROTOCOL_NAMESPACE } from '../src/bridge/protocol';

describe('isProtocolMessage', () => {
  it('accepts a well-formed request message', () => {
    expect(
      isProtocolMessage({
        __ns: PROTOCOL_NAMESPACE,
        nonce: 'abc',
        kind: 'request',
        id: '1',
        method: 'priceToY',
        args: [100],
      }),
    ).toBe(true);
  });

  it('rejects a message from a different namespace', () => {
    expect(isProtocolMessage({ __ns: 'someone-elses-namespace', nonce: 'abc', kind: 'init' })).toBe(
      false,
    );
  });

  it('rejects non-objects', () => {
    expect(isProtocolMessage(null)).toBe(false);
    expect(isProtocolMessage('hello')).toBe(false);
    expect(isProtocolMessage(42)).toBe(false);
    expect(isProtocolMessage(undefined)).toBe(false);
  });

  it('rejects an object missing a nonce', () => {
    expect(isProtocolMessage({ __ns: PROTOCOL_NAMESPACE, kind: 'init' })).toBe(false);
  });

  it('rejects an unrecognized kind', () => {
    expect(isProtocolMessage({ __ns: PROTOCOL_NAMESPACE, nonce: 'abc', kind: 'sabotage' })).toBe(
      false,
    );
  });
});

describe('readProtocolMessage — the §4.2 same-frame trust boundary', () => {
  it('accepts a message whose source is window and origin matches location.origin', () => {
    const event = new MessageEvent('message', {
      data: { __ns: PROTOCOL_NAMESPACE, nonce: 'abc', kind: 'init' },
      origin: location.origin,
      source: window,
    });
    expect(readProtocolMessage(event)).toEqual({
      __ns: PROTOCOL_NAMESPACE,
      nonce: 'abc',
      kind: 'init',
    });
  });

  it('rejects a message whose source is not window (a different frame)', () => {
    const fakeSource = {} as Window;
    const event = new MessageEvent('message', {
      data: { __ns: PROTOCOL_NAMESPACE, nonce: 'abc', kind: 'init' },
      origin: location.origin,
      source: fakeSource,
    });
    expect(readProtocolMessage(event)).toBeNull();
  });

  it('rejects a message from a different origin', () => {
    const event = new MessageEvent('message', {
      data: { __ns: PROTOCOL_NAMESPACE, nonce: 'abc', kind: 'init' },
      origin: 'https://evil.example.com',
      source: window,
    });
    expect(readProtocolMessage(event)).toBeNull();
  });

  it('rejects a same-origin message with an unrecognized shape (e.g. a page script spoofing junk)', () => {
    const event = new MessageEvent('message', {
      data: { totally: 'unrelated' },
      origin: location.origin,
      source: window,
    });
    expect(readProtocolMessage(event)).toBeNull();
  });
});
