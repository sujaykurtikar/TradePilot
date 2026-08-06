/**
 * Waits until the chart bridge reports available before anything mounts —
 * mounting against a chart that hasn't finished loading would just show a
 * widget with no real anchoring, worse than waiting (§7.1).
 */

import type { BridgeClient } from '../bridge/BridgeClient';
import { getLogger } from '../utils/logger';

const log = getLogger('content:chart-ready');

export interface WaitOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_POLL_MS = 300;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Resolves true once bridge.isAvailable() reports true, false on timeout. Never throws. */
export function waitForChartReady(bridge: BridgeClient, opts: WaitOptions = {}): Promise<boolean> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let cancelled = false;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    const finish = (ready: boolean): void => {
      if (cancelled) return;
      cancelled = true;
      if (intervalHandle !== null) clearInterval(intervalHandle);
      resolve(ready);
    };

    intervalHandle = setInterval(() => {
      let available = false;
      try {
        available = bridge.isAvailable();
      } catch (error) {
        log.debug('isAvailable() threw while polling', { error: String(error) });
      }
      if (available) {
        log.info('chart bridge ready', { elapsedMs: Date.now() - startedAt });
        finish(true);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        log.warn('chart bridge did not become ready before timeout', { timeoutMs });
        finish(false);
      }
    }, pollIntervalMs);
  });
}
