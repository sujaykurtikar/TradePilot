/** Runtime environment detection — no chart-vendor knowledge here. */

export function isTopFrame(): boolean {
  try {
    return window.self === window.top;
  } catch {
    // Cross-origin access to window.top throws in a sandboxed frame — if we
    // can't tell, assume we're NOT top so we don't double-inject.
    return false;
  }
}

export function isChromeRuntimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
}

export function hasReducedMotionPreference(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Stable per-injection id, used to namespace the postMessage protocol (§4.2/§5.2). */
export function generateSessionNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for contexts without crypto.randomUUID (shouldn't happen on
  // Chrome 111+, but never throw from a nonce generator).
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
