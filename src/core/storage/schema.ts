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

export type StorageSchema = StorageSchemaV1;

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_STORAGE: StorageSchema = {
  version: 1,
  enabled: true,
  widgetCollapsed: false,
  widgetOffsets: {},
};

export const STORAGE_KEY = 'tradepilot_state';
