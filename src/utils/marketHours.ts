/**
 * Approximate NSE regular-session market-hours gate (§P5: "Poll only when
 * the tab is visible and the market is open"). The plan's own backend
 * already has this — `services/price_action/market_hours.py` — but that
 * lives in the separate quantboard-pandapath repo, not here, so its exact
 * logic (holiday calendar, special sessions) isn't available to mirror.
 *
 * This is a deliberately approximate client-side stand-in: Mon-Fri,
 * 09:15-15:30 IST, no holiday calendar. It exists to avoid polling all
 * night/weekend every 5-30s for nothing — being a few minutes off at the
 * open/close edge, or polling on a market holiday, is a wasted request,
 * not a safety issue (the real correctness backstop is `is_fresh` from
 * the API response itself, which this can never substitute for).
 */

const IST_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
  weekday: 'short',
});

const MARKET_OPEN_MINUTES = 9 * 60 + 15; // 09:15
const MARKET_CLOSE_MINUTES = 15 * 60 + 30; // 15:30

export function isMarketOpenIst(now: Date): boolean {
  const parts = IST_TIME_FORMATTER.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);

  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;

  const minutesSinceMidnight = hour * 60 + minute;
  return (
    minutesSinceMidnight >= MARKET_OPEN_MINUTES && minutesSinceMidnight <= MARKET_CLOSE_MINUTES
  );
}
