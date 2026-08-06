import { describe, it, expect } from 'vitest';
import { clamp, nearlyEqual, formatPrice } from '../src/utils/dom';

describe('clamp', () => {
  it('clamps below the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it('clamps above the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
  it('passes through values already in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('nearlyEqual — the §R-P4a sub-pixel skip', () => {
  it('treats sub-pixel differences as equal by default', () => {
    expect(nearlyEqual(100, 100.3)).toBe(true);
  });
  it('treats a full-pixel difference as NOT equal', () => {
    expect(nearlyEqual(100, 101)).toBe(false);
  });
  it('respects a custom epsilon', () => {
    expect(nearlyEqual(100, 102, 3)).toBe(true);
    expect(nearlyEqual(100, 102, 1)).toBe(false);
  });
});

describe('formatPrice', () => {
  it('fixes to 2 decimals by default', () => {
    expect(formatPrice(24120)).toBe('24120.00');
    expect(formatPrice(24120.5)).toBe('24120.50');
  });
  it('honors a custom decimal count', () => {
    expect(formatPrice(24120.567, 1)).toBe('24120.6');
  });
});
