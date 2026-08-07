/**
 * chrome.storage.local schema (§P1: "Storage with schema + migrations
 * scaffold"). Versioned from day one so a future field change is a
 * migration, not a silent shape drift that crashes on read.
 */

import type { TradingMode } from '../../models/TradingMode';

export interface WidgetOffset {
  readonly dx: number;
  readonly dy: number;
}

export interface StorageSchemaV1 {
  readonly version: 1;
  /** popup's enable/disable toggle — Bootstrap checks this before mounting anything. */
  readonly enabled: boolean;
  readonly widgetCollapsed: boolean;
  readonly widgetOffsets: Readonly<Record<string, WidgetOffset>>;
}

/**
 * v2 adds `widgetHiddenReason` (§7.7's degradation table: "Symbol
 * unmapped: widget hidden with a reason in the popup" — the popup had no
 * way to show that reason until this field existed). This is the actual
 * first exercise of the migration scaffold migrations.ts was built for.
 */
export interface StorageSchemaV2 {
  readonly version: 2;
  readonly enabled: boolean;
  readonly widgetCollapsed: boolean;
  readonly widgetOffsets: Readonly<Record<string, WidgetOffset>>;
  /** null = widget is visible (or not yet mounted); non-null = why content/Bootstrap.ts called widget.setHidden(true). */
  readonly widgetHiddenReason: string | null;
}

/**
 * v3 adds `tradingMode` — the explicit on-chart trading mode toggle
 * ('strategy' = today's backend-suggested trade, 'personal' = user picks
 * direction/strike and drags TP/SL themselves; see
 * src/models/TradingMode.ts). Explicit, not derived from anything else —
 * an existing install with no opinion defaults to 'strategy' so it keeps
 * behaving exactly as it does today until the user deliberately switches it.
 */
export interface StorageSchemaV3 {
  readonly version: 3;
  readonly enabled: boolean;
  readonly widgetCollapsed: boolean;
  readonly widgetOffsets: Readonly<Record<string, WidgetOffset>>;
  readonly widgetHiddenReason: string | null;
  readonly tradingMode: TradingMode;
}

export type StorageSchema = StorageSchemaV3;

export const CURRENT_SCHEMA_VERSION = 3;

export const DEFAULT_STORAGE: StorageSchema = {
  version: 3,
  enabled: true,
  widgetCollapsed: false,
  widgetOffsets: {},
  widgetHiddenReason: null,
  tradingMode: 'strategy',
};

export const STORAGE_KEY = 'tradepilot_state';
