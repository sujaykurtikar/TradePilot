/**
 * SPA navigation detection (§R-P1: "patch pushState/replaceState, listen
 * to popstate, plus a MutationObserver backstop. Both targets are SPAs.").
 *
 * Caveat worth recording: content scripts run in an ISOLATED JS world.
 * `window.history` is the same underlying browser object as the page's,
 * but wrapping `history.pushState` from the isolated world is
 * best-effort — Chrome's isolated-world model does not guarantee that
 * patching a method here intercepts a call the page's own MAIN-world
 * script makes directly on its own `history` reference. That's why this
 * is layered with two world-independent signals that don't rely on
 * intercepting the page's call at all: `popstate` (a real browser event
 * that dispatches through the shared DOM regardless of which world
 * triggered the navigation) and a shallow MutationObserver on
 * `document.body`'s direct children (scoped shallow + debounced
 * specifically so it doesn't fire on high-frequency price-tick DOM
 * updates elsewhere in the page — those mutate deeply nested nodes, not
 * body's direct children).
 */

import { getLogger } from '../utils/logger';

const log = getLogger('content:spa-nav');

const MUTATION_DEBOUNCE_MS = 250;

export class SpaNavigationObserver {
  private readonly onNavigate: () => void;
  private mutationObserver: MutationObserver | null = null;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private originalPushState: History['pushState'] | null = null;
  private originalReplaceState: History['replaceState'] | null = null;
  private lastPath = location.pathname + location.search;

  constructor(onNavigate: () => void) {
    this.onNavigate = onNavigate;
  }

  private fireDebounced = (): void => {
    if (this.debounceHandle !== null) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      const path = location.pathname + location.search;
      if (path === this.lastPath) return; // e.g. an unrelated body mutation
      this.lastPath = path;
      log.debug('SPA navigation detected', { path });
      this.onNavigate();
    }, MUTATION_DEBOUNCE_MS);
  };

  private readonly onPopState = (): void => this.fireDebounced();

  start(): void {
    window.addEventListener('popstate', this.onPopState);

    // Best-effort patch — see class header caveat. Typed directly against
    // History's own method signatures, no `any` needed.
    try {
      this.originalPushState = history.pushState.bind(history);
      this.originalReplaceState = history.replaceState.bind(history);
      const patchedPushState: History['pushState'] = (...args) => {
        this.originalPushState?.(...args);
        this.fireDebounced();
      };
      const patchedReplaceState: History['replaceState'] = (...args) => {
        this.originalReplaceState?.(...args);
        this.fireDebounced();
      };
      history.pushState = patchedPushState;
      history.replaceState = patchedReplaceState;
    } catch (error) {
      log.debug('history patch failed (non-fatal, popstate + MutationObserver still cover us)', {
        error: String(error),
      });
    }

    this.mutationObserver = new MutationObserver(() => this.fireDebounced());
    this.mutationObserver.observe(document.body, { childList: true, subtree: false });
  }

  /** Restores patched history methods and disconnects observers — §7.4 "restorable". */
  stop(): void {
    window.removeEventListener('popstate', this.onPopState);
    if (this.debounceHandle !== null) clearTimeout(this.debounceHandle);
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.originalPushState) history.pushState = this.originalPushState;
    if (this.originalReplaceState) history.replaceState = this.originalReplaceState;
  }
}
