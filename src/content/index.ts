/**
 * ISOLATED-world entry point (IMPLEMENTATION_PLAN.md §5.1). Injected by
 * the manifest's `world: "ISOLATED"` content-script entries
 * (src/manifest.ts). Everything real lives in Bootstrap.ts — kept this
 * file to just wiring so the injection entry point itself never needs to
 * change as the lifecycle grows.
 */

import { Bootstrap } from './Bootstrap';
import { getLogger } from '../utils/logger';

const log = getLogger('content:index');

const bootstrap = new Bootstrap();

bootstrap.start().catch((error: unknown) => {
  // Top-level catch is NOT the §7.2 "silent failure" pattern this project
  // bans — it's the required backstop at the one place nothing above it
  // can catch a throw. It still logs loudly, which is the actual
  // requirement (§7.2: "every failure surfaces in the UI, logs with
  // context, or trips the degradation path").
  log.error('bootstrap failed', { error: String(error) });
});

// §7.4/§7.5: disabling the extension must leave the page exactly as
// found. chrome.runtime provides no direct "extension disabled" content-
// script event, but the port disconnecting is the standard signal that
// the extension context has gone away (disable, reload, or uninstall).
//
// Under MV3 the background service worker is ephemeral — Chrome kills it
// after ~30s idle and respawns it on demand — and that routine recycle
// disconnects this port too, even though the extension is still very much
// enabled. Only chrome.runtime.id actually going away means real
// invalidation; a disconnect while it's still present is just the worker
// recycling, so reconnect and keep watching instead of tearing the widget
// down (that reconnect-blind version is why the widget used to die on the
// first SW recycle and need a full page reload to come back).
function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch {
    return false;
  }
}

function watchExtensionLifecycle(): void {
  try {
    const port = chrome.runtime.connect({ name: 'tradepilot-content-lifecycle' });
    port.onDisconnect.addListener(() => {
      if (isExtensionContextValid()) {
        log.debug('lifecycle port disconnected (service worker recycle) — reconnecting');
        watchExtensionLifecycle();
        return;
      }
      log.info('extension context invalidated — tearing down');
      bootstrap.destroy();
    });
  } catch (error) {
    log.debug('could not establish lifecycle port (non-fatal)', { error: String(error) });
  }
}
watchExtensionLifecycle();
