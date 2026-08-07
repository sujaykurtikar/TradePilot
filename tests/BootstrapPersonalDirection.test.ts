/**
 * Personal mode: the option side follows the TP/SL layout the user drags.
 *
 * TP above SL is a bullish structure and buys a CE; TP below SL is bearish
 * and buys a PE. These pin the flip in BOTH directions, plus the two things
 * that make it safe to have at all: the drag that caused the flip is not
 * thrown away by a re-seed, and a degenerate TP == SL layout doesn't pick a
 * side on the user's behalf.
 *
 * Everything Bootstrap composes is stubbed — this is about the direction
 * decision, not about mounting for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DegradationState } from '../src/bridge/CapabilityProbe';
import type { Bootstrap as BootstrapClass } from '../src/content/Bootstrap';

type ManualLevelDragEnd = (variant: 'tp' | 'sl', newPrice: number) => void;
interface RenderedSuggestion {
  readonly symbolLabel: string;
  readonly tp: number | null;
  readonly sl: number | null;
}

let capturedDragEnd: ManualLevelDragEnd | null = null;
const updateSuggestionSpy = vi.fn();

/** The stub chart's last close — personal levels seed at ±0.15% of this. */
const LIVE_PRICE = 100;

vi.mock('../src/bridge/BridgeClient', () => ({
  createBridgeClient: () => ({
    lastBar: () => ({ time: 1, close: LIVE_PRICE }),
    recentBars: () => null,
    symbol: () => null,
    onChange: () => () => {},
    dispose: () => {},
    probeAsync: () => Promise.resolve({}),
  }),
}));

vi.mock('../src/content/ChartReadyDetector', () => ({
  waitForChartReady: () => Promise.resolve(true),
}));

vi.mock('../src/bridge/CapabilityProbe', () => ({
  CapabilityProbe: class {
    runOnce(): Promise<DegradationState> {
      return Promise.resolve({
        mode: 'anchored',
        result: null,
        reason: 'all capability checks passed',
      } satisfies DegradationState);
    }
    startPeriodic(): () => void {
      return () => {};
    }
  },
}));

vi.mock('../src/widget/WidgetRoot', () => ({
  WidgetRoot: class {
    constructor(opts: { onManualLevelDragEnd?: ManualLevelDragEnd }) {
      capturedDragEnd = opts.onManualLevelDragEnd ?? null;
    }
    mount(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
    setMode(): void {}
    setPosition(): void {}
    setHidden(): void {}
    setDataStale(): void {}
    setCollapsedExternal(): void {}
    setUnprotectedWarning(): void {}
    updateSuggestion(data: unknown): void {
      updateSuggestionSpy(data);
    }
    setTradingMode(): void {}
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
        tradingMode: 'personal',
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

const chromeStub = {
  runtime: {
    onMessage: { addListener: () => {}, removeListener: () => {} },
    sendMessage: () => Promise.resolve(undefined),
  },
};

describe('Bootstrap — personal mode flips CE/PE with the dragged TP/SL layout', () => {
  let Bootstrap: typeof BootstrapClass;
  let boot: BootstrapClass | null = null;

  beforeEach(async () => {
    capturedDragEnd = null;
    updateSuggestionSpy.mockClear();
    Object.assign(globalThis, { chrome: chromeStub });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(window, 'location', {
      value: new URL('https://www.tradingview.com/chart/abc/'),
      writable: true,
    });
    ({ Bootstrap } = await import('../src/content/Bootstrap'));
    boot = new Bootstrap();
    void boot.start();
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

  afterEach(() => {
    boot?.destroy();
    boot = null;
  });

  function rendered(): RenderedSuggestion {
    return updateSuggestionSpy.mock.calls.at(-1)?.[0] as RenderedSuggestion;
  }

  function dragTo(variant: 'tp' | 'sl', price: number): void {
    expect(capturedDragEnd).not.toBeNull();
    capturedDragEnd?.(variant, price);
  }

  it('starts as a CE with TP above SL', () => {
    const data = rendered();
    expect(data.symbolLabel.endsWith(' CE')).toBe(true);
    expect(data.tp).toBeGreaterThan(LIVE_PRICE);
    expect(data.sl).toBeLessThan(LIVE_PRICE);
  });

  it('dragging TP below SL turns the contract into a PE', () => {
    dragTo('tp', LIVE_PRICE - 5);
    expect(rendered().symbolLabel.endsWith(' PE')).toBe(true);
  });

  it('dragging SL above TP turns the contract into a PE too — either pill implies the same layout', () => {
    dragTo('sl', LIVE_PRICE + 5);
    expect(rendered().symbolLabel.endsWith(' PE')).toBe(true);
  });

  it('dragging back across the crossover returns it to a CE', () => {
    dragTo('tp', LIVE_PRICE - 5);
    expect(rendered().symbolLabel.endsWith(' PE')).toBe(true);

    dragTo('tp', LIVE_PRICE + 5);
    expect(rendered().symbolLabel.endsWith(' CE')).toBe(true);
  });

  it('keeps the levels the flip was inferred from — the drag is the input, not something to re-seed', () => {
    const seededSl = rendered().sl;
    dragTo('tp', LIVE_PRICE - 5);

    const data = rendered();
    // An explicit Buy/Sell click re-seeds TP/SL for the new direction; a
    // drag-driven flip must not, or it would discard the level the user
    // just placed and undo the very gesture that caused the flip.
    expect(data.tp).toBe(LIVE_PRICE - 5);
    expect(data.sl).toBe(seededSl);
  });

  it('leaves the side alone when TP and SL land on the same price', () => {
    const seededSl = rendered().sl;
    expect(seededSl).not.toBeNull();

    // A drag passing exactly through the other level implies no direction;
    // picking one here would flip the contract mid-gesture.
    dragTo('tp', seededSl as number);
    expect(rendered().symbolLabel.endsWith(' CE')).toBe(true);
  });
});
