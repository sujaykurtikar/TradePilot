/**
 * chrome.storage.local schema (§P1: "Storage with schema + migrations
 * scaffold"). Versioned from day one so a future field change is a
 * migration, not a silent shape drift that crashes on read.
 */

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

export type StorageSchema = StorageSchemaV2;

export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_STORAGE: StorageSchema = {
  version: 2,
  enabled: true,
  widgetCollapsed: false,
  widgetOffsets: {},
  widgetHiddenReason: null,
};

export const STORAGE_KEY = 'tradepilot_state';
