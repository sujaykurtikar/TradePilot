/**
 * 'strategy' = today's behavior, on-chart widget shows the backend's
 * suggested trade (TP/SL from TradePilotBackend's /recommend).
 * 'personal' = user picks direction/strike themselves and drags TP/SL
 * directly on the chart, no backend suggestion involved.
 *
 * Not to be confused with WidgetMode ('anchored' | 'manual') in
 * src/widget/WidgetRoot.ts, which is about chart-coordinate-tracking
 * reliability, an unrelated concept that happens to also use the word
 * "manual" — cross-referenced here to prevent confusion.
 */
export type TradingMode = 'strategy' | 'personal';
