/**
 * §R-P1: "Single-injection guard: a `window` flag AND a DOM-id check —
 * they fail in different situations (SPA nav vs. service-worker restart vs.
 * multiple tabs)." The window flag catches a second content-script
 * instance running in the same JS context (e.g. extension reload while the
 * page is open); the DOM-id check (ShadowHost.alreadyMounted) catches a
 * case where the window flag was lost but the DOM host survived (or vice
 * versa) — belt and suspenders, per the plan's own reasoning.
 */

import { ShadowHost } from '../widget/ShadowHost';

const WINDOW_FLAG = '__tradepilotContentInjected__';

type FlaggedWindow = Window & { [WINDOW_FLAG]?: boolean };

export function shouldInject(): boolean {
  const win = window as FlaggedWindow;
  if (win[WINDOW_FLAG] === true) return false;
  if (ShadowHost.alreadyMounted()) return false;
  return true;
}

export function markInjected(): void {
  (window as FlaggedWindow)[WINDOW_FLAG] = true;
}

export function clearInjectedFlag(): void {
  delete (window as FlaggedWindow)[WINDOW_FLAG];
}
