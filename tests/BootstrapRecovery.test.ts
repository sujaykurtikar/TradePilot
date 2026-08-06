/**
 * Regression cover for the reliability bug that made the widget vanish
 * until a manual page reload: a single 'unavailable' capability probe used
 * to tear the widget down permanently, and teardown also stopped the probe
 * that would have noticed the bridge coming back.
 *
 * Everything Bootstrap composes is stubbed here — this is specifically
 * about the teardown/retry decision, not about mounting for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DegradationState } from '../src/bridge/CapabilityProbe';
import type { Bootstrap as BootstrapClass } from '../src/content/Bootstrap';

const probeTicks: ((state: DegradationState) => void)[] = [];
const destroySpy = vi.fn();
let mountedCount = 0;
let chartReady = true;
let initialProbe: DegradationState;

vi.mock('../src/bridge/BridgeClient', () => ({
  createBridgeClient: () => ({
    lastBar: () => ({ time: 1, close: 100 }),
    recentBars: () => null,
    symbol: () => null,
    onChange: () => () => {},
    dispose: () => {},
    probeAsync: () => Promise.resolve({}),
  }),
}));

vi.mock('../src/content/ChartReadyDetector', () => ({
  waitForChartReady: () => Promise.resolve(chartReady),
}));

vi.mock('../src/bridge/CapabilityProbe', () => ({
  CapabilityProbe: class {
    runOnce(): Promise<DegradationState> {
      return Promise.resolve(initialProbe);
    }
    startPeriodic(cb: (state: DegradationState) => void): () => void {
      probeTicks.push(cb);
      return () => {
        const i = probeTicks.indexOf(cb);
        if (i >= 0) probeTicks.splice(i, 1);
      };
    }
  },
}));

vi.mock('../src/widget/WidgetRoot', () => ({
  WidgetRoot: class {
    mount(): Promise<void> {
      mountedCount += 1;
      return Promise.resolve();
    }
    destroy(): void {
      destroySpy();
    }
    setMode(): void {}
    setPosition(): void {}
    setHidden(): void {}
    setDataStale(): void {}
    setCollapsedExternal(): void {}
    setUnprotectedWarning(): void {}
    updateSuggestion(): void {}
    showToast(): void {}
    resetOffsets(): void {}
    setTradeConfirm(): void {}
  },
}));

vi.mock('../src/core/storage/StorageManager', () => ({
  StorageManager: class {
    load(): Promise<unknown> {
      return Promise.resolve({
        enabled: true,
        widgetCollapsed: false,
        widgetOffsets: {},
        widgetHiddenReason: null,
      });
    }
    patch(): Promise<void> {
      return Promise.resolve();
    }
    onChange(): () => void {
      return () => {};
    }
  },
}));

const unavailable: DegradationState = {
  mode: 'unavailable',
  result: null,
  reason: 'chart bridge chain did not resolve',
};
const anchored: DegradationState = {
  mode: 'anchored',
  result: null,
  reason: 'all capability checks passed',
};

const chromeStub = {
  runtime: {
    onMessage: { addListener: () => {}, removeListener: () => {} },
    sendMessage: () => Promise.resolve(undefined),
  },
};

describe('Bootstrap — the widget recovers instead of needing a page reload', () => {
  let Bootstrap: typeof BootstrapClass;
  let boot: BootstrapClass | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    probeTicks.length = 0;
    destroySpy.mockClear();
    mountedCount = 0;
    chartReady = true;
    initialProbe = anchored;
    Object.assign(globalThis, { chrome: chromeStub });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      value: new URL('https://www.tradingview.com/chart/abc/'),
      writable: true,
    });
    ({ Bootstrap } = await import('../src/content/Bootstrap'));
  });

  afterEach(() => {
    boot?.destroy();
    boot = null;
    vi.useRealTimers();
  });

  /** Lets the chain of awaits inside start()/runOnce() settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  it('a single unavailable probe does NOT tear the widget down — transient blips are ridden out', async () => {
    boot = new Bootstrap();
    void boot.start();
    await settle();
    expect(mountedCount).toBe(1);
    expect(probeTicks.length).toBe(1);

    probeTicks[0]?.(unavailable);
    expect(destroySpy).not.toHaveBeenCalled();

    // And a recovery clears the streak, so it never accumulates across blips.
    probeTicks[0]?.(anchored);
    probeTicks[0]?.(unavailable);
    probeTicks[0]?.(unavailable);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('a sustained outage tears down, then remounts on its own once the chart returns', async () => {
    boot = new Bootstrap();
    void boot.start();
    await settle();
    const tick = probeTicks[0];

    tick?.(unavailable);
    tick?.(unavailable);
    tick?.(unavailable);
    expect(destroySpy).toHaveBeenCalledTimes(1);

    // The bug: teardown also stopped the probe, so nothing ever retried and
    // only a page reload brought the widget back. Now a retry is scheduled.
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(mountedCount).toBe(2);
  });

  /** The host page stops rendering its chart in a background tab, so every coordinate check fails there for reasons unrelated to the bridge. */
  function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('probe failures while the tab is hidden are ignored — switching tabs must not kill the widget', async () => {
    boot = new Bootstrap();
    void boot.start();
    await settle();
    const tick = probeTicks[0];

    setVisibility('hidden');
    for (let i = 0; i < 10; i++) tick?.(unavailable);
    expect(destroySpy).not.toHaveBeenCalled();

    setVisibility('visible');
  });

  it('coming back to the tab remounts a missing widget immediately, without waiting for the retry timer', async () => {
    chartReady = false;
    boot = new Bootstrap();
    void boot.start();
    await settle();
    expect(mountedCount).toBe(0);

    chartReady = true;
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(mountedCount).toBe(1);
  });

  it('a mount that fails because the chart is not ready keeps retrying rather than giving up', async () => {
    chartReady = false;
    boot = new Bootstrap();
    void boot.start();
    await settle();
    expect(mountedCount).toBe(0);

    chartReady = true;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(mountedCount).toBe(1);
  });
});
