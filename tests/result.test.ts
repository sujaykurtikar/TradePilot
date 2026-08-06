import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, mapOk, unwrapOr } from '../src/utils/result';

describe('Result', () => {
  it('ok() produces an ok result carrying its value', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('err() produces an error result carrying its error', () => {
    const r = err('boom');
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) expect(r.error).toBe('boom');
  });

  it('mapOk transforms an ok value and leaves an error untouched', () => {
    expect(mapOk(ok(2), (x) => x * 10)).toEqual(ok(20));
    expect(mapOk(err('boom'), (x: number) => x * 10)).toEqual(err('boom'));
  });

  it('unwrapOr returns the value for ok, the fallback for err', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err('boom'), 0)).toBe(0);
  });
});
