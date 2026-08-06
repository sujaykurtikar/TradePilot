/**
 * Service worker entry (§P1). MV3 service workers are ephemeral — nothing
 * here assumes persistent in-memory state survives a restart; everything
 * that needs to persist goes through StorageManager (chrome.storage.local).
 *
 * Day-1 scope: lifecycle plumbing (accept content-script ports so their
 * onDisconnect fires correctly, §7.4/§7.5) and the popup's status query.
 * Real API polling (ApiClient) and order submission (OrderService) are
 * P5/P6 — this file's shape doesn't change when they land, they're new
 * modules wired in alongside what's here.
 */

import { StorageManager } from '../core/storage/StorageManager';
import { DEFAULT_STORAGE } from '../core/storage/schema';
import { registerMessageRouter } from './MessageRouter';
import { getLogger } from '../utils/logger';

const log = getLogger('background:index');

const storage = new StorageManager();

const CONTENT_LIFECYCLE_PORT_NAME = 'tradepilot-content-lifecycle';

chrome.runtime.onInstalled.addListener((details) => {
  log.info('installed', { reason: details.reason });
  if (details.reason === 'install') {
    // Seed storage explicitly rather than relying on StorageManager's
    // read-time fallback, so the first popup open reads a real stored
    // value instead of an implicit default.
    void storage.save(DEFAULT_STORAGE);
  }
});

// Content scripts connect here purely so their `port.onDisconnect` fires
// when the extension is disabled/reloaded/uninstalled (§7.4/§7.5) — we
// don't need to do anything with the port ourselves, just accept it so
// Chrome doesn't refuse the connection outright.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_LIFECYCLE_PORT_NAME) return;
  log.debug('content lifecycle port connected', { tabId: port.sender?.tab?.id });
});

registerMessageRouter({
  storage,
  // Day-1: honest "not-checked" — see MessageRouter.ts's doc comment.
  getApiStatus: () => 'not-checked',
});

log.info('service worker started');
