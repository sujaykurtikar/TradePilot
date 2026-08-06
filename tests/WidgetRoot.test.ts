import { describe, it, expect, afterEach, vi } from 'vitest';
import { WidgetRoot } from '../src/widget/WidgetRoot';
import type { ChartBridge, ChartChangeReason, PaneRect } from '../src/bridge/ChartBridge';
import type { DraggablePosition } from '../src/models/Position';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeStubBridge(overrides: Partial<ChartBridge> = {}): ChartBridge {
  return {
    id: 'tradingview-site',
    isAvailable: () => true,
    probe: () => ({ bridgeId: 'tradingview-site', timestampMs: 0, checks: [], overall: 'full' }),
    priceToY: () => 100,
    yToPrice: () => null,
    timeToX: () => null,
    lastBar: () => ({ time: 1, close: 24120 }),
    symbol: () => 'NIFTY',
    paneRect: (): PaneRect | null => ({
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
    }),
    onChange: (_cb: (reason: ChartChangeReason) => void) => () => {},
    ...overrides,
  };
}

function makeWidget(opts: Partial<ConstructorParameters<typeof WidgetRoot>[0]> = {}) {
  return new WidgetRoot({
    bridge: makeStubBridge(),
    demoMode: false,
    suggestion: {
      symbolLabel: '24120 CE',
      livePrice: () => 24120,
      tp: 24126,
      sl: 24116,
      onTrade: () => {},
    },
    ...opts,
  });
}

describe('WidgetRoot — §R-P2 mode switching', () => {
  let widget: WidgetRoot | null = null;

  afterEach(() => {
    widget?.destroy();
    widget = null;
    document.body.innerHTML = '';
  });

  it('mounts in anchored mode by default: manual badge stays hidden, pills get a live transform', async () => {
    widget = makeWidget();
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const hostEl = document.getElementById('tradepilot-widget-host');
    expect(hostEl).not.toBeNull();
    const shadow = hostEl?.shadowRoot;
    const manualBadge = shadow?.querySelector('.tp-badge-manual') as HTMLElement | null;
    expect(manualBadge?.style.display).toBe('none');

    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement | null;
    expect(tpPill?.style.transform).not.toBe('');
  });

  it('mounts directly in manual mode when the initial probe was degraded: badge visible with the reason, fixed layout applied', async () => {
    widget = makeWidget({ initialMode: 'manual', initialManualReason: 'coordinate math failed' });
    await widget.mount();

    const hostEl = document.getElementById('tradepilot-widget-host');
    const shadow = hostEl?.shadowRoot;
    const manualBadge = shadow?.querySelector('.tp-badge-manual') as HTMLElement | null;
    expect(manualBadge?.style.display).not.toBe('none');
    expect(manualBadge?.textContent).toContain('coordinate math failed');

    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement | null;
    expect(tpPill?.style.transform).not.toBe(''); // fixed layout still positions it, just not via price
  });

  it('setMode() switches live between anchored and manual, reversibly', async () => {
    widget = makeWidget();
    await widget.mount();
    await nextFrame();

    const hostEl = document.getElementById('tradepilot-widget-host');
    const shadow = hostEl?.shadowRoot;
    const manualBadge = shadow?.querySelector('.tp-badge-manual') as HTMLElement | null;
    expect(manualBadge?.style.display).toBe('none');

    widget.setMode('manual', 'vendor deploy broke coordinate math');
    expect(manualBadge?.style.display).not.toBe('none');
    expect(manualBadge?.textContent).toContain('vendor deploy broke coordinate math');

    widget.setMode('anchored');
    expect(manualBadge?.style.display).toBe('none');
  });
});

describe('WidgetRoot — §P6t position-mode TP/SL drag', () => {
  let widget: WidgetRoot | null = null;

  afterEach(() => {
    widget?.destroy();
    widget = null;
    document.body.innerHTML = '';
  });

  function makePosition(overrides: Partial<DraggablePosition> = {}): DraggablePosition {
    return {
      positionId: 'pos-1',
      account: 'acct-1',
      symbol: 'NIFTY',
      optionType: 'CE',
      strike: 24100,
      entrySpot: 24080,
      sl: 24050,
      tp: 24150,
      delta: 0.5,
      unrealizedPnl: 100,
      tpState: { kind: 'confirmed' },
      slState: { kind: 'confirmed' },
      ...overrides,
    };
  }

  it('setPosition(non-null) switches the pills to the position levels instead of the suggestion', async () => {
    widget = makeWidget();
    await widget.mount();
    await nextFrame();

    widget.setPosition(makePosition());
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpValue = shadow?.querySelector('.tp-pill--tp .tp-pill__value');
    expect(tpValue?.textContent).toBe('24150.00'); // position.tp, not suggestion.tp (24126)
  });

  it('setPosition(null) reverts the pills back to following the suggestion', async () => {
    widget = makeWidget();
    await widget.mount();
    widget.setPosition(makePosition());
    widget.setPosition(null);
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpValue = shadow?.querySelector('.tp-pill--tp .tp-pill__value');
    expect(tpValue?.textContent).toBe('24126.00'); // back to suggestion.tp
  });

  it('a pending optimistic price renders immediately and marks the pill pending', async () => {
    widget = makeWidget();
    await widget.mount();
    widget.setPosition(makePosition({ tpState: { kind: 'pending', optimisticPrice: 24200 } }));
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpPill = shadow?.querySelector('.tp-pill--tp');
    expect(tpPill?.classList.contains('tp-pill--pending')).toBe(true);
    expect(tpPill?.querySelector('.tp-pill__value')?.textContent).toBe('24200.00');
  });

  it('a poll landing mid-drag does not yank the pill (§P6t mid-drag guard)', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => 1000 - p, yToPrice: (y) => 1000 - y });
    widget = makeWidget({ bridge });
    await widget.mount();
    widget.setPosition(makePosition());
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    // Start a drag but do NOT release it yet.
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 0, clientY: -10 }),
    );

    // A "poll" arrives mid-drag with a DIFFERENT confirmed tp.
    widget.setPosition(makePosition({ tp: 24999 }));
    await nextFrame();

    const tpValue = shadow?.querySelector('.tp-pill--tp .tp-pill__value');
    // Still showing the ORIGINAL 24150, not the poll's 24999 — the drag wasn't yanked.
    expect(tpValue?.textContent).toBe('24150.00');

    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -10 }));
  });

  it('committing a TP drag calls onPositionRiskDrag with the price computed via the bridge', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => 1000 - p, yToPrice: (y) => 1000 - y });
    const onPositionRiskDrag = vi.fn();
    widget = makeWidget({ bridge, onPositionRiskDrag });
    await widget.mount();
    widget.setPosition(makePosition()); // tp: 24150
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    // Drag UP by 50px -> with this bridge's 1000-p mapping, that's +50 price.
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -50 }));

    expect(onPositionRiskDrag).toHaveBeenCalledWith('tp', 24200);
  });

  it('dragging a pill pre-trade (no position set) never calls onPositionRiskDrag — it is purely cosmetic (§P3)', async () => {
    const onPositionRiskDrag = vi.fn();
    widget = makeWidget({ onPositionRiskDrag });
    await widget.mount();
    // No setPosition() call — pre-trade.

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -50 }));

    expect(onPositionRiskDrag).not.toHaveBeenCalled();
  });
});
