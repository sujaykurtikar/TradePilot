import { describe, it, expect, afterEach } from 'vitest';
import { WidgetRoot } from '../src/widget/WidgetRoot';
import type { ChartBridge, ChartChangeReason, PaneRect } from '../src/bridge/ChartBridge';

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
