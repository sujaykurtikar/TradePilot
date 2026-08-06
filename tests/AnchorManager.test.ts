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
