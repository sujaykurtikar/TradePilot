import { describe, it, expect } from 'vitest';
import {
  resolveHostConfigForLocation,
  TRADINGVIEW_SITE_CONFIG,
  KOTAK_NEO_CONFIG,
} from '../src/bridge/adapters/hostConfigs';

function fakeLocation(parts: Partial<Location>): Location {
  return parts as Location;
}

describe('resolveHostConfigForLocation — §P7 frame identification', () => {
  it('matches tradingview.com by hostname (same-document, no iframe nesting)', () => {
    const loc = fakeLocation({
      hostname: 'www.tradingview.com',
      protocol: 'https:',
      origin: 'https://www.tradingview.com',
    });
    expect(resolveHostConfigForLocation(loc)).toBe(TRADINGVIEW_SITE_CONFIG);
  });

  it("does NOT match Kotak's outer document (https://trade.kotakneo.com/TradeFromCharts/...) — it has no chart", () => {
    const loc = fakeLocation({
      hostname: 'trade.kotakneo.com',
      protocol: 'https:',
      origin: 'https://trade.kotakneo.com',
    });
    expect(resolveHostConfigForLocation(loc)).toBeNull();
  });

  it("does NOT match Kotak's middle static-HTML iframe (trading-view-v3/index.html) — same origin, still no chart", () => {
    const loc = fakeLocation({
      hostname: 'trade.kotakneo.com',
      protocol: 'https:',
      origin: 'https://trade.kotakneo.com',
    });
    expect(resolveHostConfigForLocation(loc)).toBeNull();
  });

  it('DOES match the innermost blob: iframe — this is the one that actually has the chart (§4.2)', () => {
    // A blob: URL's hostname is always '' (verified against Node's URL
    // parser) — this is the case a naive hostname-only check gets wrong.
    const loc = fakeLocation({
      hostname: '',
      protocol: 'blob:',
      origin: 'https://trade.kotakneo.com',
    });
    expect(resolveHostConfigForLocation(loc)).toBe(KOTAK_NEO_CONFIG);
  });

  it("rejects a blob: frame whose origin is NOT Kotak (some other site's blob, same protocol)", () => {
    const loc = fakeLocation({
      hostname: '',
      protocol: 'blob:',
      origin: 'https://evil.example.com',
    });
    expect(resolveHostConfigForLocation(loc)).toBeNull();
  });

  it('rejects an unrelated host entirely', () => {
    const loc = fakeLocation({
      hostname: 'example.com',
      protocol: 'https:',
      origin: 'https://example.com',
    });
    expect(resolveHostConfigForLocation(loc)).toBeNull();
  });
});
