/**
 * Popup: enable/disable, reset widget position, API status, version
 * (§P1). Reads/writes chrome.storage.local directly for settings that are
 * purely local (enabled toggle, position reset) — no need to round-trip
 * through the background service worker for those. The one thing only
 * the background can answer (live API reachability, once P5 lands) goes
 * through the message bus, exercising that path end-to-end even in Day-1
 * where it always reports "not-checked".
 */

import { StorageManager } from '../src/core/storage/StorageManager';
import { sendToBackground } from '../src/core/messaging/MessageBus';
import type { StatusResponse } from '../src/core/messaging/messages';
import { getLogger } from '../src/utils/logger';

const log = getLogger('popup');
const storage = new StorageManager();

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`popup.html is missing #${id}`);
  return el as T;
}

async function init(): Promise<void> {
  const enabledToggle = byId<HTMLInputElement>('enabled-toggle');
  const versionEl = byId<HTMLSpanElement>('version');
  const apiStatusEl = byId<HTMLSpanElement>('api-status');
  const resetButton = byId<HTMLButtonElement>('reset-position');

  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const state = await storage.load();
  enabledToggle.checked = state.enabled;

  enabledToggle.addEventListener('change', () => {
    void storage.patch({ enabled: enabledToggle.checked });
  });

  resetButton.addEventListener('click', () => {
    void storage.patch({ widgetOffsets: {}, widgetCollapsed: false });
    resetButton.textContent = 'Reset ✓';
    setTimeout(() => {
      resetButton.textContent = 'Reset widget position';
    }, 1200);
  });

  const status = await sendToBackground<StatusResponse>({ type: 'tradepilot/get-status' });
  applyApiStatus(apiStatusEl, status?.apiStatus ?? 'not-checked');
}

function applyApiStatus(el: HTMLSpanElement, status: StatusResponse['apiStatus']): void {
  el.classList.remove(
    'popup__status-pill--unknown',
    'popup__status-pill--reachable',
    'popup__status-pill--unreachable',
  );
  if (status === 'reachable') {
    el.textContent = 'reachable';
    el.classList.add('popup__status-pill--reachable');
  } else if (status === 'unreachable') {
    el.textContent = 'unreachable';
    el.classList.add('popup__status-pill--unreachable');
  } else {
    el.textContent = 'not checked';
    el.classList.add('popup__status-pill--unknown');
  }
}

init().catch((error: unknown) => {
  log.error('popup init failed', { error: String(error) });
});
