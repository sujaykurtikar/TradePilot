import { describe, it, expect, afterEach } from 'vitest';
import { AnchorManager } from '../src/widget/managers/AnchorManager';
import { DragManager } from '../src/widget/managers/DragManager';
import type { ChartBridge, ChartChangeReason, PaneRect } from '../src/bridge/ChartBridge';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeStubBridge(overrides: Partial<ChartBridge> = {}): ChartBridge {
  return {
    id: 'tradingview-site',
    isAvailable: () => true,
    probe: () => ({ bridgeId: 'tradingview-site', timestampMs: 0, checks: [], overall: 'full' }),
    priceToY: () => null,
    yToPrice: () => null,
    timeToX: () => null,
    lastBar: () => null,
    symbol: () => null,
    paneRect: (): PaneRect | null => ({
      x: 10,
      y: 20,
      width: 800,
      height: 500,
      right: 810,
      bottom: 520,
    }),
    onChange: (_cb: (reason: ChartChangeReason) => void) => () => {},
    ...overrides,
  };
}

describe('AnchorManager — §R-P4a', () => {
  let manager: AnchorManager | null = null;

  afterEach(() => {
    manager?.dispose();
    manager = null;
  });

  it('hides the element when priceToY returns null (never guesses)', async () => {
    const bridge = makeStubBridge({ priceToY: () => null });
    const dragManager = new DragManager();
    manager = new AnchorManager(bridge, dragManager);
    const el = document.createElement('div');

    manager.addTarget({ id: 't1', element: el, getPrice: () => 24120, pinRight: true });
    manager.start();
    await nextFrame();
    await nextFrame();

    expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
    expect(el.style.transform).toBe('');
  });

  it('hides the element when getPrice() itself returns null', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => p + 1 });
    const dragManager = new DragManager();
    manager = new AnchorManager(bridge, dragManager);
    const el = document.createElement('div');

    manager.addTarget({ id: 't1', element: el, getPrice: () => null, pinRight: true });
    manager.start();
    await nextFrame();
    await nextFrame();

    expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
  });

  // paneRect here is y: 20 -> bottom: 520.
  //
  // Two bridges, because the two ways a bridge can decline to place an
  // off-screen price are exactly what made the top and bottom edges behave
  // differently in the field: TradingView's priceToY EXTRAPOLATES past the
  // axis rather than returning null, but not in every state.
  function makeExtrapolatingBridge(): ChartBridge {
    return makeStubBridge({
      yToPrice: (y) => 25000 - y,
      priceToY: (p) => 25000 - p, // answers for everything, in pane or not
    });
  }
  function makeRefusingBridge(): ChartBridge {
    return makeStubBridge({
      yToPrice: (y) => 25000 - y,
      priceToY: (p) => (p > 24980 || p < 24480 ? null : 25000 - p),
    });
  }

  describe("offPaneBehavior: 'hide' — TP/SL pills, which go off-screen with their price", () => {
    it('hides an above-the-pane price instead of drawing it somewhere else', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 25100, // priceToY says y = -100, above paneRect.y (20)
        pinRight: true,
        offPaneBehavior: 'hide',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
    });

    it('hides a below-the-pane price the same way', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 24000, // priceToY says y = 1000, below paneRect.bottom (520)
        pinRight: true,
        offPaneBehavior: 'hide',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
    });

    // Both edges must hide identically whether the bridge extrapolates the
    // off-screen Y or refuses to give one — this is the same asymmetry that
    // mattered for 'pin' mode, for the same reason.
    it('hides the same way at the top edge when the bridge returns null instead of extrapolating', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeRefusingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 25100,
        pinRight: true,
        offPaneBehavior: 'hide',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
    });

    it('positions a hide-mode target at its exact price when that price is on the chart', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 24700, // y = 300, comfortably inside 20..520
        pinRight: true,
        offPaneBehavior: 'hide',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.classList.contains('tp-positioned--hidden')).toBe(false);
      expect(el.style.transform).toBe('translate3d(798px, 300px, 0)');
    });

    it('hides a hide-mode target when a drag offset carries it off the pane', async () => {
      // A stale offset restored from storage would otherwise strand the
      // pill on the host's time axis, below the chart.
      const dragManager = new DragManager();
      dragManager.setOffset('t1', { dx: 0, dy: 400 });
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 24700, // y = 300, in pane before the offset; 700 after
        pinRight: true,
        offPaneBehavior: 'hide',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
    });
  });

  describe("offPaneBehavior: 'pin' — stays visible pinned at the nearest edge", () => {
    it('pins an above-the-pane price to the top edge instead of dropping it', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 25100,
        pinRight: true,
        offPaneBehavior: 'pin',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      // paneRect.y (20) + PANE_EDGE_INSET_PX (18) = 38
      expect(el.classList.contains('tp-positioned--hidden')).toBe(false);
      expect(el.style.transform).toBe('translate3d(798px, 38px, 0)');
    });

    it('pins a below-the-pane price to the bottom edge', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 24000,
        pinRight: true,
        offPaneBehavior: 'pin',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.style.transform).toBe('translate3d(798px, 502px, 0)'); // 520 - 18
    });

    it('pins to the SAME edges when the bridge returns null instead of extrapolating', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(makeRefusingBridge(), dragManager);
      const elTop = document.createElement('div');
      const elBottom = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: elTop,
        getPrice: () => 25100,
        pinRight: true,
        offPaneBehavior: 'pin',
      });
      manager.addTarget({
        id: 't2',
        element: elBottom,
        getPrice: () => 24000,
        pinRight: true,
        offPaneBehavior: 'pin',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(elTop.style.transform).toBe('translate3d(798px, 38px, 0)');
      expect(elBottom.style.transform).toBe('translate3d(798px, 502px, 0)');
    });

    it('still hides an IN-RANGE price the bridge cannot place — a real unknown, not an off-screen level', async () => {
      const dragManager = new DragManager();
      manager = new AnchorManager(
        makeStubBridge({ yToPrice: (y) => 25000 - y, priceToY: () => null }),
        dragManager,
      );
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 24700,
        pinRight: true,
        offPaneBehavior: 'pin',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.classList.contains('tp-positioned--hidden')).toBe(true);
    });

    it('stops a pin-mode target at the edge when a drag carries it past', async () => {
      const dragManager = new DragManager();
      dragManager.setOffset('t1', { dx: 0, dy: 400 });
      manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
      const el = document.createElement('div');

      manager.addTarget({
        id: 't1',
        element: el,
        getPrice: () => 24700,
        pinRight: true,
        offPaneBehavior: 'pin',
      });
      manager.start();
      await nextFrame();
      await nextFrame();

      expect(el.style.transform).toBe('translate3d(798px, 502px, 0)');
    });
  });

  it('leaves an unconstrained target free to follow its drag offset out of the pane', async () => {
    const dragManager = new DragManager();
    dragManager.setOffset('t1', { dx: 0, dy: 400 });
    manager = new AnchorManager(makeExtrapolatingBridge(), dragManager);
    const el = document.createElement('div');

    manager.addTarget({ id: 't1', element: el, getPrice: () => 24700, pinRight: true });
    manager.start();
    await nextFrame();
    await nextFrame();

    expect(el.style.transform).toBe('translate3d(798px, 700px, 0)');
  });

  describe('clipSegmentToPane', () => {
    const paneRect = { x: 0, y: 20, width: 810, height: 500, right: 810, bottom: 520 };

    it('returns a segment unchanged when it lies wholly inside the pane', () => {
      manager = new AnchorManager(makeExtrapolatingBridge(), new DragManager());
      expect(manager.clipSegmentToPane(100, 300, paneRect)).toEqual({ top: 100, height: 200 });
    });

    it('trims a segment at the edge it overruns, keeping the on-chart part', () => {
      manager = new AnchorManager(makeExtrapolatingBridge(), new DragManager());
      // Endpoint 400px above the pane — the connector still draws from the
      // top edge down to the pivot instead of vanishing.
      expect(manager.clipSegmentToPane(-400, 300, paneRect)).toEqual({ top: 20, height: 280 });
      expect(manager.clipSegmentToPane(300, 900, paneRect)).toEqual({ top: 300, height: 220 });
    });

    it('returns null for a segment entirely off the chart', () => {
      manager = new AnchorManager(makeExtrapolatingBridge(), new DragManager());
      expect(manager.clipSegmentToPane(-400, -100, paneRect)).toBeNull();
      expect(manager.clipSegmentToPane(600, 900, paneRect)).toBeNull();
    });

    it('accepts endpoints in either order', () => {
      manager = new AnchorManager(makeExtrapolatingBridge(), new DragManager());
      expect(manager.clipSegmentToPane(300, -400, paneRect)).toEqual({ top: 20, height: 280 });
    });
  });

  it('positions a pinRight target at paneRect.right minus the gutter, plus any drag offset', async () => {
    const bridge = makeStubBridge({ priceToY: () => 250 });
    const dragManager = new DragManager();
    dragManager.setOffset('t1', { dx: 5, dy: -2 });
    manager = new AnchorManager(bridge, dragManager);
    const el = document.createElement('div');

    manager.addTarget({ id: 't1', element: el, getPrice: () => 24120, pinRight: true });
    manager.start();
    await nextFrame();
    await nextFrame();

    // paneRect.right (810) - GUTTER (12) + offset.dx (5) = 803; y = 250 + offset.dy (-2) = 248
    expect(el.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(el.style.transform).toBe('translate3d(803px, 248px, 0)');
  });

  it('routes X through timeToX when getTime is provided instead of pinning right', async () => {
    const bridge = makeStubBridge({
      priceToY: () => 100,
      timeToX: (t) => t / 10,
    });
    const dragManager = new DragManager();
    manager = new AnchorManager(bridge, dragManager);
    const el = document.createElement('div');

    manager.addTarget({ id: 't1', element: el, getPrice: () => 1, getTime: () => 500 });
    manager.start();
    await nextFrame();
    await nextFrame();

    expect(el.style.transform).toBe('translate3d(50px, 100px, 0)');
  });

  it('removeTarget stops positioning that element on subsequent frames', async () => {
    const bridge = makeStubBridge({ priceToY: () => 100 });
    const dragManager = new DragManager();
    manager = new AnchorManager(bridge, dragManager);
    const el = document.createElement('div');
    manager.addTarget({ id: 't1', element: el, getPrice: () => 1, pinRight: true });
    manager.start();
    await nextFrame();
    expect(el.style.transform).not.toBe('');

    manager.removeTarget('t1');
    el.style.transform = ''; // reset to prove the next frame doesn't touch it
    await nextFrame();
    expect(el.style.transform).toBe('');
  });
});
