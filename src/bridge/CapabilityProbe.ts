/**
 * Orchestrates §5.4's capability probe into the degradation-ladder
 * decision (§R-P2). The raw checks live on the bridge itself
 * (TradingViewInternalApiBridge.probe() — only it has direct access to
 * the internals being tested); this class turns that ProbeResult into
 * "what should the widget actually do about it."
 *
 * | Probe result            | mode       |
 * |--------------------------|-----------|
 * | all checks pass          | 'anchored' — full anchoring, widget rides price |
 * | chain resolves, math off | 'manual'   — fixed draggable panel + badge, still tradeable |
 * | chain doesn't resolve    | 'unavailable' — widget does not mount |
 *
 * Re-probes periodically (not just once at page load) so a vendor deploy
 * that breaks things mid-session is caught within the interval, not from
 * a bad fill (§8.1's "detectable within hours rather than from a bad
 * fill"). §5.4 also calls for pinning a `knownGoodHostBuild` marker to
 * detect a deploy proactively — that needs something to fingerprint a
 * live page's build (e.g. a version string TradingView embeds somewhere),
 * which isn't determinable from this build session without a live page to
 * inspect. Left as a documented gap rather than a fabricated fingerprint;
 * the periodic re-probe is the mechanism that actually catches breakage
 * either way, just reactively instead of proactively.
 */

import type { ProbeResult } from './ChartBridge';
import { getLogger } from '../utils/logger';

const log = getLogger('bridge:capability-probe');

export type DegradationMode = 'anchored' | 'manual' | 'unavailable';

export interface DegradationState {
  readonly mode: DegradationMode;
  readonly result: ProbeResult | null;
  readonly reason: string;
}

const DEFAULT_PERIODIC_INTERVAL_MS = 30_000;

/** The only thing CapabilityProbe actually needs — narrower than the full BridgeClient, which keeps this class trivially testable with a stub. */
export interface ProbeCapableBridge {
  probeAsync(): Promise<ProbeResult>;
}

function classify(result: ProbeResult): DegradationState {
  if (result.overall === 'full') {
    return { mode: 'anchored', result, reason: 'all capability checks passed' };
  }
  if (result.overall === 'degraded') {
    const failing = result.checks
      .filter((c) => !c.passed)
      .map((c) => c.detail ?? c.name)
      .join('; ');
    return {
      mode: 'manual',
      result,
      reason: `chart bridge resolved but coordinate math failed: ${failing || 'unknown check failure'}`,
    };
  }
  return { mode: 'unavailable', result, reason: 'chart bridge chain did not resolve' };
}

export class CapabilityProbe {
  private readonly bridge: ProbeCapableBridge;

  constructor(bridge: ProbeCapableBridge) {
    this.bridge = bridge;
  }

  /** Runs one probe and classifies it. Never throws — a probe that can't even complete is itself 'unavailable'. */
  async runOnce(): Promise<DegradationState> {
    try {
      const result = await this.bridge.probeAsync();
      const state = classify(result);
      log.info('probe result', { mode: state.mode, reason: state.reason });
      return state;
    } catch (error) {
      log.warn('probe request failed outright', { error: String(error) });
      return {
        mode: 'unavailable',
        result: null,
        reason: 'bridge did not respond to the probe request',
      };
    }
  }

  /** Re-probes on an interval, invoking `cb` on every result (not just changes — the caller decides what to do with a repeated confirmation). Returns a stop function. */
  startPeriodic(
    cb: (state: DegradationState) => void,
    intervalMs = DEFAULT_PERIODIC_INTERVAL_MS,
  ): () => void {
    let cancelled = false;
    const tick = (): void => {
      this.runOnce()
        .then((state) => {
          if (!cancelled) cb(state);
        })
        .catch((error: unknown) =>
          log.debug('periodic probe tick failed', { error: String(error) }),
        );
    };
    const handle = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }
}
