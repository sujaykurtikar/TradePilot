/**
 * Regression cover for the bug that made the on-chart card fall back to a
 * generic "TradePilot" label a couple of seconds after mounting, and made
 * personal mode answer "Waiting for live chart data before trading" on
 * every Trade click.
 *
 * Cause: bridge.symbol() returns null whenever BridgeClient's 2s cache has
 * expired, which — since symbol() is only read on 5-30s data pushes — is
 * almost always. The old code conflated that with "unknown instrument".
 */

import { describe, it, expect } from 'vitest';
import { resolveChartSymbol } from '../src/content/symbolResolution';

const MAP = { NIFTY: 'NIFTY', 'NSE:NIFTY': 'NIFTY', BANKNIFTY: 'BANKNIFTY' } as const;

describe('resolveChartSymbol', () => {
  it('maps a live chart symbol and marks it worth remembering', () => {
    expect(resolveChartSymbol('NSE:NIFTY', MAP, null)).toEqual({
      kind: 'resolved',
      symbol: 'NIFTY',
      remember: true,
    });
  });

  it('falls back to the last known symbol when the bridge cache has expired (symbol() === null)', () => {
    expect(resolveChartSymbol(null, MAP, 'NIFTY')).toEqual({
      kind: 'resolved',
      symbol: 'NIFTY',
      remember: false,
    });
  });

  it('never re-remembers a fallback — only a live chart answer is persisted', () => {
    const result = resolveChartSymbol(null, MAP, 'NIFTY');
    expect(result.kind === 'resolved' && result.remember).toBe(false);
  });

  it('reports an unmapped symbol so the caller hides the widget instead of guessing (§R-P5)', () => {
    expect(resolveChartSymbol('NASDAQ:AAPL', MAP, 'NIFTY')).toEqual({
      kind: 'unmapped',
      chartSymbol: 'NASDAQ:AAPL',
    });
  });

  it('prefers the LIVE symbol over the remembered one when they disagree', () => {
    expect(resolveChartSymbol('BANKNIFTY', MAP, 'NIFTY')).toEqual({
      kind: 'resolved',
      symbol: 'BANKNIFTY',
      remember: true,
    });
  });

  it('resolves to null (not a crash, not a guess) when nothing is known yet', () => {
    expect(resolveChartSymbol(null, MAP, null)).toEqual({
      kind: 'resolved',
      symbol: null,
      remember: false,
    });
  });

  it('does not treat an inherited Object.prototype key as a mapping', () => {
    // symbolMap is a plain object literal; a chart reporting "constructor"
    // must not resolve to Object's own property.
    expect(resolveChartSymbol('constructor', MAP, null)).toEqual({
      kind: 'unmapped',
      chartSymbol: 'constructor',
    });
  });
});
