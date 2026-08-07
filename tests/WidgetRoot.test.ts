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

  it('manual mode hides a pill whose price is null, same as anchored mode (§7.1/§R-P5 "missing tp -> hide the TP pill")', async () => {
    widget = makeWidget({
      initialMode: 'manual',
      suggestion: {
        symbolLabel: '24120 CE',
        livePrice: () => 24120,
        tp: null,
        sl: 24116,
        onTrade: () => {},
      },
    });
    await widget.mount();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement | null;
    const slPill = shadow?.querySelector('.tp-pill--sl') as HTMLElement | null;
    expect(tpPill?.classList.contains('tp-positioned--hidden')).toBe(true);
    expect(slPill?.classList.contains('tp-positioned--hidden')).toBe(false);
  });

  it('manual mode re-hides/re-shows a pill when a later update changes its price to/from null', async () => {
    widget = makeWidget({ initialMode: 'manual' }); // starts with tp: 24126 (non-null)
    await widget.mount();
    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement;
    expect(tpPill.classList.contains('tp-positioned--hidden')).toBe(false);

    widget.updateSuggestion({
      symbolLabel: '24120 CE',
      livePrice: () => 24120,
      tp: null,
      sl: 24116,
      onTrade: () => {},
    });
    expect(tpPill.classList.contains('tp-positioned--hidden')).toBe(true);
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

  it('dragging a pill pre-trade in strategy mode (default) never calls onManualLevelDragEnd either', async () => {
    const onManualLevelDragEnd = vi.fn();
    widget = makeWidget({ onManualLevelDragEnd });
    await widget.mount();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -50 }));

    expect(onManualLevelDragEnd).not.toHaveBeenCalled();
  });

  it('dragging a pill pre-trade in personal mode calls onManualLevelDragEnd with the bridge-computed price', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => 1000 - p, yToPrice: (y) => 1000 - y });
    const onManualLevelDragEnd = vi.fn();
    const onPositionRiskDrag = vi.fn();
    widget = makeWidget({
      bridge,
      initialTradingMode: 'personal',
      onManualLevelDragEnd,
      onPositionRiskDrag,
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24150,
        tp: 24150,
        sl: 24100,
        onTrade: () => {},
      },
    });
    await widget.mount();
    // No setPosition() call — personal mode's whole point is pre-trade.

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -50 }));

    expect(onManualLevelDragEnd).toHaveBeenCalledWith('tp', 24200);
    expect(onPositionRiskDrag).not.toHaveBeenCalled();
  });

  it('personal-mode drag commit resets the pill screen offset, so the next render lands exactly on the new price (not the new price PLUS the old drag delta)', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => 1000 - p, yToPrice: (y) => 1000 - y });
    widget = makeWidget({
      bridge,
      initialTradingMode: 'personal',
      // Mirrors what Bootstrap.ts's real onManualLevelDragEnd callback does:
      // synchronously feed the new price back in via updateSuggestion()
      // before handleLevelDragEnd returns.
      onManualLevelDragEnd: (variant, newPrice) => {
        widget?.updateSuggestion({
          symbolLabel: 'NIFTY CE',
          livePrice: () => 24150,
          tp: variant === 'tp' ? newPrice : 24150,
          sl: variant === 'sl' ? newPrice : 24100,
          onTrade: () => {},
        });
      },
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24150,
        tp: 24150,
        sl: 24100,
        onTrade: () => {},
      },
    });
    await widget.mount();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    const pill = shadow?.querySelector('.tp-pill--tp') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -50 }));
    await nextFrame();

    // New price is 24200 -> priceToY(24200) = 1000 - 24200 = -23200.
    // If the -50 drag offset were still applied on top (the bug), this
    // would instead read -23250.
    expect(pill.style.transform).toContain('-23200');
  });

  it('an open position still wins over personal mode — dragging goes to onPositionRiskDrag, not onManualLevelDragEnd', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => 1000 - p, yToPrice: (y) => 1000 - y });
    const onManualLevelDragEnd = vi.fn();
    const onPositionRiskDrag = vi.fn();
    widget = makeWidget({
      bridge,
      initialTradingMode: 'personal',
      onManualLevelDragEnd,
      onPositionRiskDrag,
    });
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
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: -50 }));

    expect(onPositionRiskDrag).toHaveBeenCalledWith('tp', 24200);
    expect(onManualLevelDragEnd).not.toHaveBeenCalled();
  });
});

describe('WidgetRoot — §7.1/§3 visibility and staleness controls', () => {
  let widget: WidgetRoot | null = null;

  afterEach(() => {
    widget?.destroy();
    widget = null;
    document.body.innerHTML = '';
  });

  it('setDataStale(true) dims the pills and suggestion card, never the R-OCO banner or badges', async () => {
    widget = makeWidget({ demoMode: true });
    await widget.mount();
    widget.setDataStale(true);

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    expect(shadow?.querySelector('.tp-pill--tp')?.classList.contains('tp-dimmed')).toBe(true);
    expect(shadow?.querySelector('.tp-pill--sl')?.classList.contains('tp-dimmed')).toBe(true);
    expect(shadow?.querySelector('.tp-card')?.classList.contains('tp-dimmed')).toBe(true);
    expect(shadow?.querySelector('.tp-banner-unprotected')?.classList.contains('tp-dimmed')).toBe(
      false,
    );
    expect(shadow?.querySelector('.tp-badge-demo')?.classList.contains('tp-dimmed')).toBe(false);

    widget.setDataStale(false);
    expect(shadow?.querySelector('.tp-pill--tp')?.classList.contains('tp-dimmed')).toBe(false);
  });

  it('setUnprotectedWarning shows/hides the R-OCO banner with the given message', async () => {
    widget = makeWidget();
    await widget.mount();
    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const banner = shadow?.querySelector('.tp-banner-unprotected') as HTMLElement;
    expect(banner.style.display).toBe('none');

    widget.setUnprotectedWarning(true, '⚠ Backend unreachable — 1 open position(s) unprotected!');
    expect(banner.style.display).not.toBe('none');
    expect(banner.textContent).toContain('unprotected');

    widget.setUnprotectedWarning(false);
    expect(banner.style.display).toBe('none');
  });

  it('setHidden hides the whole layer independent of collapse state', async () => {
    widget = makeWidget();
    await widget.mount();
    const layer = document
      .getElementById('tradepilot-widget-host')
      ?.shadowRoot?.querySelector('.tp-layer') as HTMLElement;
    expect(layer.style.display).not.toBe('none');
    widget.setHidden(true);
    expect(layer.style.display).toBe('none');
    widget.setHidden(false);
    expect(layer.style.display).not.toBe('none');
  });
});
