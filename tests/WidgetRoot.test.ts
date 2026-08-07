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

  it('switching to manual mode hides the connector line instead of leaving it stranded at its last anchored-mode position', async () => {
    // A scale that separates tp/sl/livePrice — the default stub maps every
    // price to the same y, which collapses the line to nothing to draw.
    widget = makeWidget({
      bridge: makeStubBridge({ priceToY: (p) => 24400 - p, yToPrice: (y) => 24400 - y }),
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const lineTp = shadow?.querySelector('.tp-connector-line--tp') as HTMLElement;
    const lineSl = shadow?.querySelector('.tp-connector-line--sl') as HTMLElement;
    // Anchored mode with valid tp/sl/livePrice draws the line.
    expect(lineTp.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(lineSl.classList.contains('tp-positioned--hidden')).toBe(false);

    // setMode('manual') stops the rAF loop that positions the line every
    // frame (AnchorManager.onFrame) — without an explicit hide, it would
    // stay painted at whatever transform it had the instant before, while
    // the pills separately jump to the fixed manual-layout stack. That
    // mismatch is what showed up live as a stray oversized line.
    widget.setMode('manual', 'coordinate math failed');
    expect(lineTp.classList.contains('tp-positioned--hidden')).toBe(true);
    expect(lineSl.classList.contains('tp-positioned--hidden')).toBe(true);
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
    const bridge = makeStubBridge({ priceToY: (p) => 24400 - p, yToPrice: (y) => 24400 - y });
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
    const bridge = makeStubBridge({ priceToY: (p) => 24400 - p, yToPrice: (y) => 24400 - y });
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
    const bridge = makeStubBridge({ priceToY: (p) => 24400 - p, yToPrice: (y) => 24400 - y });
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
    const bridge = makeStubBridge({ priceToY: (p) => 24400 - p, yToPrice: (y) => 24400 - y });
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

    // New price is 24200 -> priceToY(24200) = 24400 - 24200 = 200.
    // If the -50 drag offset were still applied on top (the bug), this
    // would instead read 150.
    expect(pill.style.transform).toContain('200px, 0)');
  });

  it('an open position still wins over personal mode — dragging goes to onPositionRiskDrag, not onManualLevelDragEnd', async () => {
    const bridge = makeStubBridge({ priceToY: (p) => 24400 - p, yToPrice: (y) => 24400 - y });
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

describe('WidgetRoot — zooming a level off the visible price axis', () => {
  let widget: WidgetRoot | null = null;

  afterEach(() => {
    widget?.destroy();
    widget = null;
    document.body.innerHTML = '';
  });

  /**
   * Pane spans y 0..600, priced 25000 (top) down to 24400 (bottom).
   *
   * priceToY returns NULL outside that range — matching the real adapter,
   * which refuses to extrapolate past the pane (§R-P4a). yToPrice still
   * answers at the pane edges, which is how an off-screen level's edge is
   * determined. An earlier version of these fixtures let priceToY
   * extrapolate; that modelled a bridge we don't have, and hid the fact
   * that the connector line was left with no endpoint to reach for.
   */
  function makeZoomedBridge(): ChartBridge {
    return makeStubBridge({
      yToPrice: (y) => 25000 - y,
      priceToY: (p) => (p > 25000 || p < 24400 ? null : 25000 - p),
    });
  }

  it('takes an off-screen TP pill off-screen with its price, while the connector keeps stretching to the pane edge', async () => {
    widget = makeWidget({
      bridge: makeZoomedBridge(),
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24600, // y = 400
        tp: 25400, // y = -400: rescaled out of view above the pane
        sl: 24500, // y = 500: still visible
        onTrade: () => {},
      },
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement;
    const slPill = shadow?.querySelector('.tp-pill--sl') as HTMLElement;
    const lineTp = shadow?.querySelector('.tp-connector-line--tp') as HTMLElement;
    const lineSl = shadow?.querySelector('.tp-connector-line--sl') as HTMLElement;

    // Off the chart with its price — the pill only ever moves relative to
    // price via its own drag handle, never because of a rescale.
    expect(tpPill.classList.contains('tp-positioned--hidden')).toBe(true);
    expect(slPill.style.transform).toContain('500px, 0)');

    // The connector is the thing that must NOT disappear: it stretches to
    // the pane's top edge (0) and keeps running down to the pivot, so it
    // reads as "the level is off-screen up there" rather than as broken.
    expect(lineTp.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(lineTp.style.transform).toContain('0px, 0)');
    expect(lineTp.style.height).toBe('400px'); // pane top (0) -> the 400 pivot
    expect(lineSl.style.height).toBe('100px');
  });

  it('runs the connector to the edge for a level held back by the pill inset, not to a bare point', async () => {
    // Observed live: TP resolved to y=50 in a pane starting at y=42 — on
    // the chart as far as the bridge was concerned, but inside the pill's
    // half-height inset, so the pill was held back while the line drew
    // right up to y=50 and stopped there with nothing on the end of it.
    // The line must reach the edge instead, so it reads as "the level is
    // off the top" rather than as a broken line.
    widget = makeWidget({
      bridge: makeZoomedBridge(),
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24600, // y = 400
        tp: 24990, // y = 10: inside the pane (0..600), inside the 18px inset
        sl: 24500, // y = 500
        onTrade: () => {},
      },
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement;
    const lineTp = shadow?.querySelector('.tp-connector-line--tp') as HTMLElement;

    expect(tpPill.classList.contains('tp-positioned--hidden')).toBe(true);
    expect(lineTp.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(lineTp.style.transform).toContain('0px, 0)'); // the pane's top edge, not y=10
    expect(lineTp.style.height).toBe('400px');
  });

  it('hides a connector half only once none of it is on the chart at all', async () => {
    widget = makeWidget({
      bridge: makeZoomedBridge(),
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 25200, // y = -200: pivot itself above the pane
        tp: 25400, // y = -400
        sl: 24500, // y = 500
        onTrade: () => {},
      },
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    // -400..-200 is entirely above the pane, so there is nothing to draw.
    expect(
      shadow?.querySelector('.tp-connector-line--tp')?.classList.contains('tp-positioned--hidden'),
    ).toBe(true);
    // -200..500 still crosses the chart, so the visible 0..500 part draws.
    const lineSl = shadow?.querySelector('.tp-connector-line--sl') as HTMLElement;
    expect(lineSl.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(lineSl.style.height).toBe('500px');
  });

  it('hides an off-screen SL the same way — both edges behave identically', async () => {
    widget = makeWidget({
      bridge: makeZoomedBridge(),
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24600, // y = 400
        tp: 24500, // y = 500, visible
        sl: 23800, // y = 1200: rescaled out of view below the pane
        onTrade: () => {},
      },
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const slPill = shadow?.querySelector('.tp-pill--sl') as HTMLElement;
    const lineSl = shadow?.querySelector('.tp-connector-line--sl') as HTMLElement;

    expect(slPill.classList.contains('tp-positioned--hidden')).toBe(true);
    // Connector still stretches to the bottom edge (600) rather than
    // vanishing with the pill.
    expect(lineSl.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(lineSl.style.height).toBe('200px'); // the 400 pivot -> pane bottom (600)
  });

  it('ignores a persisted TP/SL offset entirely — the pill renders at its real price, not an old build\'s leftover position', async () => {
    // A level offset can only be a leftover from before drag commits
    // started zeroing it (see the constructor comment above initialOffsets)
    // — the constructor filters it out rather than restoring it. Without
    // that filter this dy:300 would push a y=300 pill to y=600, off the
    // pane, and hide it.
    const onOffsetChange = vi.fn();
    widget = makeWidget({
      bridge: makeZoomedBridge(),
      initialOffsets: {
        'level-pill-tp': { dx: 0, dy: 300 },
        'suggestion-card': { dx: 0, dy: 25 },
      },
      onOffsetChange,
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24600, // y = 400
        tp: 24700, // y = 300
        sl: 24500, // y = 500
        onTrade: () => {},
      },
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement;
    const card = shadow?.querySelector('.tp-card') as HTMLElement;

    expect(tpPill.classList.contains('tp-positioned--hidden')).toBe(false);
    expect(tpPill.style.transform).toContain('300px, 0)');
    // The card's own offset IS cosmetic and still applies: 400 + 25.
    expect(card.style.transform).toContain('425px, 0)');
  });

  it('a pill dragged past the pane edge mid-drag hides, and the connector stretches to meet it', async () => {
    widget = makeWidget({
      bridge: makeZoomedBridge(),
      suggestion: {
        symbolLabel: 'NIFTY CE',
        livePrice: () => 24600, // y = 400
        tp: 24700, // y = 300, starts on-screen
        sl: 24500, // y = 500
        onTrade: () => {},
      },
    });
    await widget.mount();
    await nextFrame();
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    // Drag DOWN 400px: y 300 + 400 = 700, well past paneRect.bottom (600).
    handle.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 0, clientY: 400 }),
    );
    await nextFrame();
    await nextFrame();

    const tpPill = shadow?.querySelector('.tp-pill--tp') as HTMLElement;
    const lineTp = shadow?.querySelector('.tp-connector-line--tp') as HTMLElement;
    expect(tpPill.classList.contains('tp-positioned--hidden')).toBe(true);
    // The connector stretches to the bottom edge instead of following the
    // pill off the chart or vanishing.
    expect(lineTp.classList.contains('tp-positioned--hidden')).toBe(false);

    handle.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 400 }),
    );
  });

  it('never writes a level offset back to storage, so stale values stop being refreshed', async () => {
    const onOffsetChange = vi.fn();
    widget = makeWidget({ bridge: makeZoomedBridge(), onOffsetChange });
    await widget.mount();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 40 }));

    expect(onOffsetChange).not.toHaveBeenCalledWith('level-pill-tp', expect.anything());
  });

  it('measures a drag from the level price itself, so a drag moves TP by exactly the distance dragged', async () => {
    const onPositionRiskDrag = vi.fn();
    widget = makeWidget({ bridge: makeZoomedBridge(), onPositionRiskDrag });
    await widget.mount();
    widget.setPosition({
      positionId: 'pos-1',
      account: 'acct-1',
      symbol: 'NIFTY',
      optionType: 'CE',
      strike: 24100,
      entrySpot: 24080,
      tp: 24700, // y = 300, on screen and grabbable
      sl: 24500,
      delta: 0.5,
      unrealizedPnl: 100,
      tpState: { kind: 'confirmed' },
      slState: { kind: 'confirmed' },
    });
    await nextFrame();

    const shadow = document.getElementById('tradepilot-widget-host')?.shadowRoot;
    const handle = shadow?.querySelector('.tp-pill--tp .tp-pill__handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, button: 0 }),
    );
    handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 40 }));

    // y 300 + 40 = 340 -> price 25000 - 340 = 24660, i.e. exactly the 40
    // points dragged, measured from the level's own price.
    expect(onPositionRiskDrag).toHaveBeenCalledWith('tp', 24660);
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
