import { describe, it, expect, vi } from 'vitest';
import { CapabilityProbe, type ProbeCapableBridge } from '../src/bridge/CapabilityProbe';
import type { ProbeResult } from '../src/bridge/ChartBridge';

function stubBridge(probeAsync: () => Promise<ProbeResult>): ProbeCapableBridge {
  return { probeAsync };
}

const FULL_RESULT: ProbeResult = {
  bridgeId: 'tradingview-site',
  timestampMs: 0,
  checks: [{ name: 'chain-resolves', passed: true }],
  overall: 'full',
};

const DEGRADED_RESULT: ProbeResult = {
  bridgeId: 'tradingview-site',
  timestampMs: 0,
  checks: [
    { name: 'chain-resolves', passed: true },
    { name: 'priceToY-in-pane', passed: false, detail: 'coordinate outside pane' },
  ],
  overall: 'degraded',
};

const UNAVAILABLE_RESULT: ProbeResult = {
  bridgeId: 'tradingview-site',
  timestampMs: 0,
  checks: [{ name: 'chain-resolves', passed: false, detail: 'chain did not resolve' }],
  overall: 'unavailable',
};

describe('CapabilityProbe — §5.4/§R-P2 classification', () => {
  it('classifies "full" as anchored mode', async () => {
    const probe = new CapabilityProbe(stubBridge(() => Promise.resolve(FULL_RESULT)));
    const state = await probe.runOnce();
    expect(state.mode).toBe('anchored');
    expect(state.result).toEqual(FULL_RESULT);
  });

  it('classifies "degraded" as manual mode, with the failing check(s) in the reason', async () => {
    const probe = new CapabilityProbe(stubBridge(() => Promise.resolve(DEGRADED_RESULT)));
    const state = await probe.runOnce();
    expect(state.mode).toBe('manual');
    expect(state.reason).toContain('coordinate outside pane');
  });

  it('classifies "unavailable" as unavailable mode', async () => {
    const probe = new CapabilityProbe(stubBridge(() => Promise.resolve(UNAVAILABLE_RESULT)));
    const state = await probe.runOnce();
    expect(state.mode).toBe('unavailable');
  });

  it('a probe request that rejects outright is also treated as unavailable (never throws)', async () => {
    const probe = new CapabilityProbe(stubBridge(() => Promise.reject(new Error('timed out'))));
    await expect(probe.runOnce()).resolves.toEqual(
      expect.objectContaining({ mode: 'unavailable', result: null }),
    );
  });

  it('startPeriodic invokes the callback on an interval and stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      const probeAsync = vi.fn(() => Promise.resolve(FULL_RESULT));
      const probe = new CapabilityProbe(stubBridge(probeAsync));
      const cb = vi.fn();
      const stop = probe.startPeriodic(cb, 1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb).toHaveBeenCalledTimes(2); // no further calls after stop()
    } finally {
      vi.useRealTimers();
    }
  });
});
