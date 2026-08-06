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

export function resolveHostConfigForLocation(loc: Location = window.location): InternalApiHostConfig | null {
  if (loc.hostname === 'www.tradingview.com') return TRADINGVIEW_SITE_CONFIG;
  if (loc.hostname === 'trade.kotakneo.com') return KOTAK_NEO_CONFIG;
  return null;
}
