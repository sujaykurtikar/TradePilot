/**
 * Decides which instrument the on-chart widget is currently looking at.
 *
 * Split out of Bootstrap.applyMarketData so it can be tested directly —
 * getting this wrong means labelling (and potentially trading) the wrong
 * instrument, which makes it the one piece of that method worth pinning
 * down with unit tests rather than reasoning about in place.
 *
 * The subtlety is that `bridge.symbol()` returning null does NOT mean
 * "this chart has no symbol". BridgeClient.syncCall serves a cache that
 * expires after CACHE_STALE_MS (2s), and symbol() is only read on backend
 * data pushes (every 5-30s) — so the cache is reliably expired by the
 * time it's asked, and null is the COMMON answer, not an edge case.
 * Treating that as "unknown instrument" degraded the card to a generic
 * label and left personal mode with no tradeable suggestion a couple of
 * seconds after the widget came up correctly.
 */

export type SymbolResolution =
  /** Chart reported a symbol we have no mapping for — §R-P5: hide, don't guess. */
  | { readonly kind: 'unmapped'; readonly chartSymbol: string }
  /**
   * `symbol` is the instrument to use (null only if the chart has not yet
   * reported one at all). `remember` is true only when this came from a
   * live chart answer, so callers persist a value they can fall back on
   * without ever persisting a fallback of a fallback.
   */
  | { readonly kind: 'resolved'; readonly symbol: string | null; readonly remember: boolean };

export function resolveChartSymbol(
  chartSymbol: string | null,
  symbolMap: Readonly<Record<string, string>>,
  lastKnownMappedSymbol: string | null,
): SymbolResolution {
  // "Can't answer right now" — reuse what the chart last actually said.
  // Safe because the caller invalidates that memory on a real symbol
  // change, on an unmapped symbol, and on teardown/navigation, so it can
  // never outlive the instrument it describes.
  if (chartSymbol === null) {
    return { kind: 'resolved', symbol: lastKnownMappedSymbol, remember: false };
  }

  // hasOwnProperty, not plain indexing: symbolMap is a plain object
  // literal, so `symbolMap['constructor']` (or 'toString', …) would
  // otherwise resolve to an inherited Object.prototype member — a
  // function where the type says string — and be reported as a
  // successfully mapped instrument.
  const mapped = Object.prototype.hasOwnProperty.call(symbolMap, chartSymbol)
    ? symbolMap[chartSymbol]
    : undefined;
  if (typeof mapped !== 'string') return { kind: 'unmapped', chartSymbol };
  return { kind: 'resolved', symbol: mapped, remember: true };
}
