import { describe, it, expect, afterEach } from 'vitest';
import { TradingViewInternalApiBridge } from '../src/bridge/adapters/TradingViewInternalApiBridge';
import { TRADINGVIEW_SITE_CONFIG } from '../src/bridge/adapters/hostConfigs';

/**
 * Exercises TradingViewInternalApiBridge against a hand-built mock of the
 * verified §4.1 call chain (activeChart().chartWidget().paneWidgets()[0]
 * .state().defaultPriceScale() / .model().model().timeScale() /
 * .mainSeries()). This can't prove the REAL tradingview.com/Kotak object
 * shapes still match (that needs the live-browser soak, §P8) — it proves
 * the bridge's own traversal/math logic is correct against the shape the
 * plan's probe recorded, and that a malformed shape degrades safely
 * instead of throwing.
 */

const PANE_RECT = { x: 56, y: 42, width: 1200, height: 611, right: 1256, bottom: 653 };
const LAST_BAR = [1785936600, 305, 311, 304, 309.61, 23707268] as const;
const LAST_INDEX = 1106;

function priceToCoordinate(price: number): number {
  return 400 - price; // higher price -> smaller y, like a real chart's price axis
}
function coordinateToPrice(y: number): number {
  return 400 - y;
}
function indexToCoordinate(index: number): number {
  return index - 1000;
}

function makeSubscription(): {
  subscribe: (ctx: unknown, cb: () => void) => void;
  unsubscribe: (ctx: unknown, cb: () => void) => void;
  fire: () => void;
} {
  const listeners = new Set<() => void>();
  return {
    subscribe: (_ctx, cb) => listeners.add(cb),
    unsubscribe: (_ctx, cb) => listeners.delete(cb),
    fire: () => listeners.forEach((cb) => cb()),
  };
}

function installMockTradingViewApi(
  overrides: { priceToCoordinate?: (p: number) => number } = {},
): void {
  const priceScale = {
    priceToCoordinate: overrides.priceToCoordinate ?? priceToCoordinate,
    coordinateToPrice,
  };
  const timeScale = { indexToCoordinate };
  const bars = {
    lastIndex: () => LAST_INDEX,
    valueAt: (i: number) => (i === LAST_INDEX ? [...LAST_BAR] : undefined),
  };
  const mainSeries = { bars: () => bars };
  const model = { timeScale: () => timeScale, mainSeries: () => mainSeries };
  const paneWidget = {
    state: () => ({ defaultPriceScale: () => priceScale }),
    canvasElement: () => ({ getBoundingClientRect: () => PANE_RECT }),
  };
  const chartWidget = {
    paneWidgets: () => [paneWidget],
    model: () => ({ model: () => model }),
  };
  const chart = {
    chartWidget: () => chartWidget,
    symbol: () => 'NIFTY',
    onVisibleRangeChanged: makeSubscription,
    onSymbolChanged: makeSubscription,
    onIntervalChanged: makeSubscription,
    onDataLoaded: makeSubscription,
  };

  (window as any).TradingViewApi = { activeChart: () => chart };
}

function uninstallMockTradingViewApi(): void {
  delete (window as any).TradingViewApi;
}

describe('TradingViewInternalApiBridge', () => {
  afterEach(() => uninstallMockTradingViewApi());

  it('isAvailable() is false when the global is absent', () => {
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.isAvailable()).toBe(false);
  });

  it('isAvailable() is true once the full chain resolves', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.isAvailable()).toBe(true);
  });

  it('priceToY converts using the verified formula: paneRect.y + priceToCoordinate(price)', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    // priceToCoordinate(309.61) = 90.39; viewport y = 42 + 90.39 = 132.39
    expect(bridge.priceToY(309.61)).toBeCloseTo(132.39, 5);
  });

  it('priceToY returns null when the computed coordinate falls outside the pane', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.priceToY(100000)).toBeNull(); // wildly off-chart price
  });

  it('yToPrice round-trips priceToY within tolerance', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    const y = bridge.priceToY(309.61);
    expect(y).not.toBeNull();
    expect(bridge.yToPrice(y as number)).toBeCloseTo(309.61, 5);
  });

  it('lastBar returns the verified [time, o, h, l, close, volume] shape, projected to {time, close}', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.lastBar()).toEqual({ time: 1785936600, close: 309.61 });
  });

  it('timeToX finds the matching bar and converts via indexToCoordinate', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    // indexToCoordinate(1106) = 106; viewport x = paneRect.x(56) + 106 = 162
    expect(bridge.timeToX(1785936600)).toBe(162);
  });

  it('timeToX returns null for a time with no matching bar', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.timeToX(1)).toBeNull();
  });

  it('symbol() returns the chart symbol', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.symbol()).toBe('NIFTY');
  });

  it('paneRect() mirrors the canvas bounding rect as a plain object', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(bridge.paneRect()).toEqual(PANE_RECT);
  });

  it('probe() reports overall "unavailable" when the global is absent', () => {
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    const result = bridge.probe();
    expect(result.overall).toBe('unavailable');
    expect(result.checks.find((c) => c.name === 'chain-resolves')?.passed).toBe(false);
  });

  it('probe() reports overall "full" when every coordinate check passes', () => {
    installMockTradingViewApi();
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    const result = bridge.probe();
    expect(result.overall).toBe('full');
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('probe() reports overall "degraded" when the chain resolves but coordinate math is broken — the dangerous case §5.4 calls out ("a method that exists but returns garbage is more dangerous than one that\'s missing")', () => {
    installMockTradingViewApi({ priceToCoordinate: () => 999999 }); // resolves, but way off-pane
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    const result = bridge.probe();
    expect(result.overall).toBe('degraded');
  });

  it('never throws into the caller when a vendor method is missing entirely (guarded())', () => {
    (window as any).TradingViewApi = { activeChart: () => ({}) }; // chartWidget() missing
    const bridge = new TradingViewInternalApiBridge(TRADINGVIEW_SITE_CONFIG);
    expect(() => bridge.priceToY(100)).not.toThrow();
    expect(bridge.priceToY(100)).toBeNull();
    expect(() => bridge.probe()).not.toThrow();
  });
});
