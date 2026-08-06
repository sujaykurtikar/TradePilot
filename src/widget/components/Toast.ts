/**
 * Minimal transient toast, rendered inside the Shadow DOM layer.
 *
 * Day-1 use (§6.0): the Trade button's placeholder confirm — "shows a
 * confirm toast/log ... and does nothing else. No network call." P6
 * replaces the click behavior with the real confirm dialog + order call;
 * this same primitive is reusable there for success/error notices.
 */

const DEFAULT_DURATION_MS = 4000;

export function showToast(
  layer: HTMLElement,
  message: string,
  durationMs = DEFAULT_DURATION_MS,
): void {
  const toast = document.createElement('div');
  toast.className = 'tp-toast tp-mount-animate';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.textContent = message;
  toast.style.cssText = [
    'position: fixed',
    'left: 50%',
    'bottom: 24px',
    'transform: translateX(-50%)',
    'background: var(--tp-color-bg-solid)',
    'color: var(--tp-color-text)',
    'border: 1px solid var(--tp-color-border)',
    'border-radius: var(--tp-radius-md)',
    'padding: 10px 16px',
    'font-family: var(--tp-font-family)',
    'font-size: var(--tp-font-size-md)',
    'box-shadow: var(--tp-shadow-card)',
    'pointer-events: none',
    'z-index: 2147483003',
  ].join(';');

  layer.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}
