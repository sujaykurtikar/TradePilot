/**
 * Service worker entry (§P1/§P5). MV3 service workers are ephemeral —
 * nothing here assumes persistent in-memory state survives a restart;
 * everything that needs to persist goes through StorageManager
 * (chrome.storage.local). DataPoller's in-memory snapshot does NOT
 * survive a restart, which is an accepted gap noted below.
 */

import { StorageManager } from '../core/storage/StorageManager';
import { DEFAULT_STORAGE } from '../core/storage/schema';
import { registerMessageRouter } from './MessageRouter';
import { TabRegistry } from './TabRegistry';
import { ApiClient } from './ApiClient';
import { DataPoller } from './DataPoller';
import { isMarketOpenIst } from '../utils/marketHours';
import type { DataUpdateMessage } from '../core/messaging/messages';
import { getLogger } from '../utils/logger';

const log = getLogger('background:index');

const storage = new StorageManager();
const tabRegistry = new TabRegistry();

// §10 Q3: "Where does the API run? http://127.0.0.1:8000 assumes same
// machine as the browser." Kept as a constant rather than a popup
// setting for now — making this configurable is real, deferred scope,
// not an oversight; flagging it rather than silently hardcoding it.
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000';
const apiClient = new ApiClient({ baseUrl: DEFAULT_API_BASE_URL });

const CONTENT_LIFECYCLE_PORT_NAME = 'tradepilot-content-lifecycle';

const poller = new DataPoller({
  apiClient,
  shouldPoll: () => tabRegistry.anyVisible() && isMarketOpenIst(new Date()),
  onUpdate: (snapshot) => {
    const message: DataUpdateMessage = { type: 'tradepilot/data-update', snapshot };
    for (const tabId of tabRegistry.activeTabIds()) {
      chrome.tabs.sendMessage(tabId, message).catch((error: unknown) => {
        // A tab can disappear between activeTabIds() and the send (race,
        // not a bug) — log at debug, not error; onDisconnect will clean
        // the registry up shortly regardless.
        log.debug('push to tab failed (likely a closing tab)', { tabId, error: String(error) });
      });
    }
  },
});

chrome.runtime.onInstalled.addListener((details) => {
  log.info('installed', { reason: details.reason });
  if (details.reason === 'install') {
    // Seed storage explicitly rather than relying on StorageManager's
    // read-time fallback, so the first popup open reads a real stored
    // value instead of an implicit default.
    void storage.save(DEFAULT_STORAGE);
  }
});

// Content scripts connect here so (a) their `port.onDisconnect` fires
// when the extension is disabled/reloaded/uninstalled (§7.4/§7.5), which
// is also exactly the signal to remove them from TabRegistry, and (b)
// registration itself marks the tab as one DataPoller should push to.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTENT_LIFECYCLE_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;
  log.debug('content lifecycle port connected', { tabId });
  tabRegistry.register(tabId);
  port.onDisconnect.addListener(() => {
    log.debug('content lifecycle port disconnected', { tabId });
    tabRegistry.unregister(tabId);
  });
});

registerMessageRouter({
  storage,
  tabRegistry,
  getApiStatus: () => {
    const snapshot = poller.getSnapshot();
    if (snapshot.lastSuccessAtMs !== null) return 'reachable';
    if (snapshot.lastError !== null) return 'unreachable';
    return 'not-checked';
  },
});

poller.start();

// MV3 service workers can be terminated after ~30s of inactivity and
// woken by an event; DataPoller's own setTimeout chain does NOT survive
// that (a known, documented MV3 limitation for near-real-time polling —
// there is no sub-minute-accurate alarm API to fall back on, since
// chrome.alarms' minimum period is ~1 minute). This 1-minute alarm is a
// best-effort keepalive: if the worker was asleep and just woke up for
// this alarm, `poller.start()` is a no-op if already running and resumes
// the loop if it had stopped. It does NOT guarantee sub-30s cadence
// through an idle period — only that polling resumes within about a
// minute of the worker waking for any reason, extension-reload included.
void chrome.alarms.create('tradepilot-poller-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'tradepilot-poller-keepalive') return;
  poller.start();
});

log.info('service worker started');
