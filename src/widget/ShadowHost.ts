/**
 * Owns the single Shadow DOM host mounted into the page (§P3, §7.4 "No
 * host CSS modified"). Styles are fetched via chrome.runtime.getURL and
 * inlined as a <style> inside the shadow root — a same-extension fetch, so
 * it needs no `web_accessible_resources` entry (that's only required for
 * resources referenced directly from host-page-visible DOM/URLs).
 */

import { getLogger } from '../utils/logger';

const log = getLogger('widget:shadow-host');

const HOST_ELEMENT_ID = 'tradepilot-widget-host';
const STYLE_FILES = ['styles/tokens.css', 'styles/widget.css', 'styles/animations.css'];

export class ShadowHost {
  readonly hostElement: HTMLDivElement;
  readonly shadowRoot: ShadowRoot;
  readonly layer: HTMLDivElement;
  private stylesLoaded = false;

  constructor() {
    this.hostElement = document.createElement('div');
    this.hostElement.id = HOST_ELEMENT_ID;
    // The host element itself must never affect host-page layout.
    this.hostElement.style.all = 'initial';
    this.hostElement.style.position = 'fixed';
    this.hostElement.style.top = '0';
    this.hostElement.style.left = '0';
    this.hostElement.style.width = '0';
    this.hostElement.style.height = '0';
    this.hostElement.style.zIndex = '2147483000';

    this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
    this.layer = document.createElement('div');
    this.layer.className = 'tp-layer';
    this.shadowRoot.appendChild(this.layer);
  }

  /** §R-P1 injection guard: refuse to double-mount within one document. */
  static alreadyMounted(): boolean {
    return document.getElementById(HOST_ELEMENT_ID) !== null;
  }

  async loadStyles(): Promise<void> {
    if (this.stylesLoaded) return;
    const style = document.createElement('style');
    try {
      const chunks = await Promise.all(
        STYLE_FILES.map(async (path) => {
          const url = chrome.runtime.getURL(path);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`failed to fetch ${path}: ${res.status}`);
          return res.text();
        }),
      );
      style.textContent = chunks.join('\n');
      this.stylesLoaded = true;
    } catch (error) {
      // A missing stylesheet must not crash the widget — it'll render
      // unstyled rather than not at all, and the failure is logged loudly
      // (§7.2 "no silent failures").
      log.error('failed to load widget styles', { error: String(error) });
    }
    this.shadowRoot.insertBefore(style, this.layer);
  }

  mount(): void {
    if (this.hostElement.isConnected) return;
    document.documentElement.appendChild(this.hostElement);
  }

  /** Full teardown (§7.5/§R-P1) — removes the host element from the DOM entirely. */
  destroy(): void {
    this.hostElement.remove();
  }
}
