/**
 * §6.0 Day-1 demo: "Hardcoded suggestion: { entry: <current spot ±
 * offset>, tp, sl, strike: '<ATM> CE' }" — "no /recommend call, just
 * numbers in a config object." Computed ONCE from a real observed spot
 * price (so the demo looks plausible on whatever instrument the chart
 * happens to be showing), then held fixed — exactly like a real
 * suggestion would be until the next refresh, not recalculated every
 * frame. P5 replaces this whole module with the real `/recommend` call;
 * nothing else in the widget layer changes.
 */

export interface DemoSuggestionConfig {
  readonly strikeLabel: string; // e.g. "24120 CE"
  readonly entry: number;
  readonly tp: number;
  readonly sl: number;
}

const STRIKE_INTERVAL = 50; // NIFTY-shaped default; not instrument-aware — Day-1 only.
const TP_OFFSET = 6;
const SL_OFFSET = 4;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildDemoSuggestionConfig(spot: number): DemoSuggestionConfig {
  const atmStrike = Math.round(spot / STRIKE_INTERVAL) * STRIKE_INTERVAL;
  return {
    strikeLabel: `${atmStrike} CE`,
    entry: round2(spot),
    tp: round2(spot + TP_OFFSET),
    sl: round2(spot - SL_OFFSET),
  };
}

/** Used only if no live bar was observed within the demo's short grace window — clearly a fallback, never silent. */
export const DEMO_FALLBACK_SPOT = 24000;
