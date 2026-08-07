/**
 * Per-host configuration for TradingViewInternalApiBridge
 * (IMPLEMENTATION_PLAN.md §4.2/§5.2). tradingview.com and Kotak Neo are
 * confirmed to expose the *same* internal method chain — this table is the
 * only thing that differs between them: which global to look for, and how
 * to translate the host's own symbol string to our instrument name.
 */

export interface InternalApiHostConfig {
  readonly id: 'tradingview-site' | 'kotak-neo';
  /**
   * Frame this host's chart lives in. TradingView is same-document (no
   * iframe); Kotak nests it three levels deep in a `blob:` iframe (§4.2).
   * Informational here — actual frame targeting is done by the manifest's
   * content-script `matches`/`all_frames` entries (src/manifest.ts), since
   * a MAIN-world script only ever runs in the frame it was injected into.
   */
  readonly frameDescription: string;
  /** tried in order; first one present on `window` wins */
  readonly candidateGlobals: readonly string[];
  /** host's own symbol string -> our instrument name. Unmapped hides the widget (§R-P5). */
  readonly symbolMap: Readonly<Record<string, string>>;
}

export const TRADINGVIEW_SITE_CONFIG: InternalApiHostConfig = {
  id: 'tradingview-site',
  frameDescription: 'same-document, no iframe (§4.1)',
  candidateGlobals: ['TradingViewApi'],
  symbolMap: {
    NIFTY: 'NIFTY',
    'NSE:NIFTY': 'NIFTY',
    BANKNIFTY: 'BANKNIFTY',
    'NSE:BANKNIFTY': 'BANKNIFTY',
  },
};

export const KOTAK_NEO_CONFIG: InternalApiHostConfig = {
  id: 'kotak-neo',
  frameDescription: 'innermost blob: iframe, 3 levels deep (§4.2)',
  // Kotak's global is named `tradingViewApi` (lowercase t); tradingview.com
  // uses `TradingViewApi`. Since both host configs share this ONE adapter
  // class, try both names rather than hardcoding.
  candidateGlobals: ['tradingViewApi', 'TradingViewApi'],
  symbolMap: {
    // Confirmed live via the §4.2 probe.
    'NSE_CM|NIFTY 50': 'NIFTY',
    // Not yet confirmed against a live BANKNIFTY chart — §10 Q7. Best-guess
    // shape based on the confirmed NIFTY entry; verify before relying on it
    // in P7 and correct here if wrong.
    'NSE_CM|NIFTY BANK': 'BANKNIFTY',
  },
};

const KOTAK_ORIGIN = 'https://trade.kotakneo.com';

/**
 * P7: identifies which frame (of the three the manifest injects into,
 * §4.2) is actually the chart-hosting one.
 *
 * A `blob:` URL's `.hostname` is ALWAYS the empty string — it has no
 * hierarchical authority component, unlike an http(s) URL. Verified with
 * Node's URL parser: `new URL('blob:https://trade.kotakneo.com/<uuid>')`
 * gives `hostname: ''`, `protocol: 'blob:'`, `origin:
 * 'https://trade.kotakneo.com'`. A hostname-only check (what this
 * function originally did) therefore matches Kotak's outer document and
 * middle static-HTML iframe — the two frames WITHOUT a chart — and never
 * matches the innermost blob iframe, which is exactly backwards: the
 * widget would try to bootstrap in the two frames that can never satisfy
 * it and time out, and never even attempt the one that would work.
 *
 * The fix: `origin` (not `hostname`) is what a blob URL correctly
 * inherits from its creating context (also why the postMessage protocol's
 * `event.origin === location.origin` check in protocol.ts/§4.2 works
 * inside that frame unmodified) — so Kotak's match requires BOTH
 * `protocol === 'blob:'` (this is specifically the innermost frame, not
 * either outer one) AND `origin === KOTAK_ORIGIN` (this blob belongs to
 * Kotak, not some other site's blob: URL, which shares the `blob:`
 * protocol but never Kotak's origin).
 */
/**
 * TradingView redirects users to a regional subdomain based on locale
 * (e.g. in.tradingview.com for India, not just www.tradingview.com) —
 * same app, same internal API global, different hostname. Matching by
 * suffix rather than the single exact "www" hostname is required for the
 * widget to bootstrap at all for any non-US-default user (manifest.ts's
 * content_scripts matches this same pattern for the same reason).
 */
function isTradingViewHostname(hostname: string): boolean {
  return hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com');
}

export function resolveHostConfigForLocation(
  loc: Location = window.location,
): InternalApiHostConfig | null {
  if (isTradingViewHostname(loc.hostname)) return TRADINGVIEW_SITE_CONFIG;
  if (loc.protocol === 'blob:' && loc.origin === KOTAK_ORIGIN) return KOTAK_NEO_CONFIG;
  return null;
}
