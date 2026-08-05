# Chart Trade Overlay — Implementation Plan

**Status:** Planning only. No implementation started.
**Date:** 2026-08-05
**Goal:** A Zing-style on-chart trade widget — TP pill above, "Suggested / <strike> / [Trade]" card at the live entry price, SL pill below — where the entry marker rides the live price and TP/SL auto-derive from market structure, and one click places the order through our own wrapper API.
**Overriding requirement from the user: RELIABILITY.** Every phase below carries an explicit *Reliability Requirements* block, and §7 defines the engineering standard those blocks are measured against. Nothing in this plan ships without meeting it.

**Descoped by user decision:** SEBI algo-registration and broker/TradingView policy constraints. This is a personal-use tool, not a public product, and orders route through our own wrapper API. I raised these in the previous revision; you've made the call, so they are recorded once in §8.6 as a note and are not treated as blockers anywhere else in this plan.

---

## 1. TL;DR — the decision

I reviewed `C:\Users\sujay\CKProjects\quantboard-pandapath`. **It changes the recommendation completely.**

That project already contains almost every hard part of this feature. It is not a greenfield build — it is an increment on working code.

| | **Track A — in-app overlay** (`quantboard-pandapath`) | **Track B — Chrome extension** (tradingview.com / Kotak Neo / Dhan) |
|---|---|---|
| Chart API | `lightweight-charts` v5.2 — **documented, semver-stable, already in use** | Undocumented internals, reverse-engineered |
| Can it break without warning? | **No.** We pin the version. | **Yes.** Any vendor deploy can break it. |
| Code we control | 100% | ~0% of the host page |
| Backend / levels / orders | **Already built** (§2) | Would call the same backend, over the network |
| Distribution | `npm run dev`, it's our app | Load-unpacked, per-browser |
| Effort to first working widget | **~3–4 days** | ~2 weeks |
| Reliability ceiling | **Very high** | Medium at best |

### Recommendation

> **Build Track A first.** It is faster, dramatically more reliable, and it is the only place where the whole loop — live price → levels → widget → order → position — is under our control end to end.
>
> **Then Track B**, reusing the exact same backend contracts and the exact same visual component. By then the widget is proven and the extension is only an adapter problem.

The two tracks share ~70% of the work if we design the boundary correctly from day one (§6). Building A first is therefore not a detour — it is the cheapest possible way to de-risk B.

---

## 2. What already exists in `quantboard-pandapath`

This is the single most important section in the document. **Do not rebuild any of it.**

### 2.1 Frontend — `apps/web` (Next.js 16, React 19, TypeScript)

| Capability | Location | Notes |
|---|---|---|
| Chart engine | `lightweight-charts@^5.2.0` | TradingView's **open-source** library. Documented public API. |
| Main chart | `src/components/Chart/LiveOIChart.tsx` (48 KB) | The real one. OI overlay, view modes, tooltips. |
| Simple chart | `src/components/Chart/TradingChart.tsx` | Candles + pivot S/R price lines. |
| **`priceToCoordinate` already in use** | `LiveOIChart.tsx:437,445,520,769,773` | ✅ The exact price→pixel primitive this feature needs. **No reverse engineering required.** |
| **rAF overlay render loop** | `LiveOIChart.tsx:566-572` | Already solves "lightweight-charts has no Y-axis-scroll event" — the canvas overlay redraws every frame. |
| **Entry / TP / SL price lines** | `LiveOIChart.tsx:648-730` | Per open position, colored by strategy, with P&L in the label. |
| **Drag-to-adjust TP/SL** | `LiveOIChart.tsx:753-800+` | Capture-phase mousedown, hit-test within `DRAG_HIT_PX`, disables `handleScroll`/`handleScale` during drag, and the poll skips a line that is mid-drag. Comment literally says *"Kotak/Lemon-style"*. |
| Support / Resistance lines | `LiveOIChart.tsx:732-751` | Fed by OI-derived `support_strike` / `resistance_strike` from the backend. |
| Pivot S/R (client-side) | `TradingChart.tsx:13-31` `dailyPivotLevels()` | Floor-trader pivots; mirrors `services/banknifty/levels.py`. |
| Premium↔spot mapping | `premiumToSpot(pos, price)` in `LiveOIChart.tsx` | Uses option **delta** to project a premium-space TP/SL onto the spot price scale. Non-trivial, already solved. |
| Suggestion banner | `src/components/TradeRecommendationLine.tsx` | Polls `/v1/paper/recommend` every 5s, renders direction, symbol, LTP, SL, TP, score, rationale. **This is the widget's data, just rendered as a text bar instead of an on-chart card.** |
| API client | `src/lib/paperClient.ts` + types `ChartPosition`, `ChartStateResponse` | Typed. |
| Styling | CSS Modules (`*.module.css`) + `lucide-react` icons | Existing dark theme. |

### 2.2 Backend — `apps/api` (FastAPI) + `services/`

| Endpoint | What it returns / does |
|---|---|
| `GET /v1/paper/chart/state` | **Everything the chart needs in one call**: `spot`, `atm_strike`, `strike_interval`, `lot_size`, `expiry`, `is_fresh`, `trader` status, `strategies[]` with signals, and `positions[]` each annotated with `sl`, `tp`, `entry_spot`, `risk_pts`, `reward_pts`, `rr_ratio`, `delta`, `unrealized_pnl`. |
| `GET /v1/paper/recommend` | `{trade_recommended, direction, recommended_symbol, recommended_ltp, recommended_option_type, sl, tp, composite_score, rationale[], no_trade_reason}` |
| `POST /v1/paper/manual/order` | `PlaceOrderRequest{direction, lots, order_type, limit_price, sl, tp, strike, option_type, strategy}` — **this is the "Trade" button's target.** |
| `POST /v1/paper/position/risk` | `UpdateRiskRequest{position_id, account, sl, tp}` — **this is drag-to-adjust's target.** |
| `POST /v1/paper/manual/square_off`, `/manual/flatten` | Exit paths. |
| `POST /v1/execution/execute`, `/halt`, `/resume` | Live execution + kill switch. |
| `GET /v1/paper/chain` | Option chain. |

### 2.3 Broker wrapper — this is the "custom wrapper API" you referred to

```
packages/contracts/broker.py        BrokerPort: place_order(OrderIntent) → str
                                              modify_order(order_id, new_price) → bool
                                              cancel_order(order_id) → bool
packages/broker_kotak_neo/adapter.py         Kotak Neo (direct)
packages/broker_kotak_neo_remote/adapter.py  Kotak Neo (remote/proxied)
packages/broker_upstox/                      Upstox
services/execution/engine.py                 execution engine + halt/resume
services/execution/broker_settings_store.py  credentials/config
```

The port/adapter split is already correct. The Trade button **never** touches a broker — it calls our own FastAPI route, which calls `BrokerPort`. Adding another broker later is one adapter file.

### 2.4 Levels & analytics already present

`services/banknifty/levels.py`, `services/banknifty/suggestion_engine.py`, `services/price_action/{analyzer,engine,feeder}.py`, `services/liquidity_engine/`, `services/regime_classifier/`, `services/trade_management/manager.py`, `services/signal_tournament/`.

### 2.5 Therefore — the actual gap

Everything below the UI exists. **The gap is exactly three things:**

1. **A pre-trade suggestion has no on-chart representation.** Price lines are drawn only for *open positions*. The *suggestion* is a text banner. We need it on the chart, at the price, before entry.
2. **No HTML widget layer.** TP/SL are lightweight-charts `PriceLine` objects (a line + an axis label). The Zing design needs real DOM: rounded pills, a card with a logo and a `Trade` button, hover states, a `×`. `PriceLine` cannot render that.
3. **Nothing tracks live price continuously as a *suggestion*.** `entry_spot` is fixed at fill time. We need an entry marker that rides the live price until the user commits.

**That's the build. It is small, and it sits on top of proven code.**

---

## 3. Track A — in-app overlay (PRIMARY)

Target: `apps/web/src/components/Chart/` in `quantboard-pandapath`.

### 3.1 Architecture

A **DOM overlay layer** absolutely positioned over the chart container, siblings with the existing OI canvas. Not canvas — we need real buttons, hover, focus, and text.

```
<div class={styles.chartWrap}  position: relative>
  <div ref={chartContainerRef} />                      ← lightweight-charts (unchanged)
  <canvas ref={canvasRef} class={styles.oiOverlay} />  ← existing OI overlay (unchanged)
  <TradeWidgetLayer                                    ← NEW: pointer-events:none container
      chart={chartRef.current}
      series={seriesRef.current}
      suggestion={suggestion}
      onTrade={placeOrder}
      onAdjust={updateRisk} />
</div>
```

**Positioning primitive — the whole feature in four lines:**

```ts
const y   = series.priceToCoordinate(price);              // documented, stable
const x   = chart.timeScale().timeToCoordinate(lastTime); // documented, stable
const w   = chart.timeScale().width();                    // for right-edge anchoring
// → transform: translate3d(x, y, 0) on an absolutely-positioned element
```

Both return `null` when the price/time is outside the visible range. **`null` is not an error — it is the signal to hide that element.** Every call site must handle it explicitly; see §7.

### 3.2 New files

```
apps/web/src/components/Chart/TradeWidget/
├── TradeWidgetLayer.tsx        # container; owns the rAF sync loop; pointer-events:none
├── SuggestionCard.tsx          # "⚡ Suggested / 24120 CE / [Trade]"
├── LevelPill.tsx               # reusable TP/SL pill (variant: 'tp' | 'sl')
├── useChartAnchor.ts           # hook: (price) → {x, y, visible}; rAF-synced
├── useLiveSuggestion.ts        # hook: polls/streams /recommend + /chart/state, merges, debounces
├── useDragLevel.ts             # drag a pill vertically → price (reuses the LiveOIChart pattern)
├── TradeWidget.module.css      # all styling, CSS variables
└── types.ts                    # Suggestion, AnchorPoint, WidgetState
```

**Only one existing file is touched:** `LiveOIChart.tsx` gains the `<TradeWidgetLayer/>` sibling and passes `chartRef`/`seriesRef` down. That is the entire integration surface — deliberately, so the widget can be removed by deleting one line.

### 3.3 The anchor loop (`useChartAnchor`)

The existing code already proves the pattern: lightweight-charts emits no event for Y-axis scroll, so `LiveOIChart.tsx:566` runs a permanent `requestAnimationFrame` loop. We **join that existing loop** rather than starting a second one.

```ts
// Called from inside the existing renderLoop, once per frame:
function syncAnchors() {
  const s = seriesRef.current, ts = chartRef.current?.timeScale();
  if (!s || !ts) return;                       // chart torn down mid-frame — bail, don't throw

  for (const anchor of anchors) {
    const y = s.priceToCoordinate(anchor.price);
    const x = anchor.pinRight ? ts.width() - RIGHT_GUTTER : ts.timeToCoordinate(anchor.time);

    if (y == null || x == null) { hide(anchor); continue; }   // off-screen → hide, never guess
    if (Math.abs(y - anchor.lastY) < 0.5 &&
        Math.abs(x - anchor.lastX) < 0.5) continue;           // sub-pixel → skip the write

    anchor.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;   // compositor only
    anchor.lastX = x; anchor.lastY = y;
  }
}
```

**Reliability Requirements — R-A1**
- `transform` only. **Never** `top`/`left` — that triggers layout inside the chart's own render frame and will visibly stutter the candles.
- Sub-pixel skip (`< 0.5px`) so a still chart does zero DOM writes. Idle CPU cost must be ~0.
- `null` from either conversion → **hide the element**. Never fall back to a stale or extrapolated coordinate; a widget showing a wrong price is worse than a widget showing nothing.
- Guard every frame against a torn-down chart (`seriesRef.current` null). React StrictMode double-mounts in dev — this *will* happen.
- One rAF loop for the whole chart. Adding a second is a defect.
- Budget: **< 0.3 ms per frame** for the whole layer, verified in the Performance panel with 3 levels + 2 open positions on screen.

### 3.4 Data flow (`useLiveSuggestion`)

```
GET /v1/paper/chart/state   → spot, atm_strike, strike_interval, lot_size, expiry, is_fresh, positions[]
GET /v1/paper/recommend     → direction, recommended_symbol/option_type/ltp, sl, tp, score, rationale
        ↓ merge + validate + debounce
   Suggestion { entryPrice, strikeLabel, tp, sl, direction, score, rationale, stale }
        ↓
   TradeWidgetLayer → SuggestionCard @ entryPrice, LevelPill(tp) @ tp, LevelPill(sl) @ sl
```

`TradeRecommendationLine.tsx` already polls `/recommend` at 5s. Keep that cadence for **levels**; drive the **entry marker** off the live spot in `chart/state` / the existing tick stream, so the card feels alive while the levels stay deliberate.

**Reliability Requirements — R-A2**
- **Single in-flight request per endpoint.** Abort the previous with `AbortController` before issuing the next. A slow response must never overwrite a newer one (classic last-write-wins bug in the existing 5s-interval pattern).
- **Staleness is visible, not silent.** `chart/state` already returns `is_fresh`. If `is_fresh === false`, or the last successful poll is older than 15s, the widget **dims and shows `stale`, and the Trade button is disabled.** Never render a confident-looking price we can't vouch for.
- **Backoff on failure:** 5s → 10s → 20s → 30s cap, reset on first success. Do not hammer a dead API every 5s for an hour.
- **Validate every payload at the boundary.** A type guard, not a cast. `sl`/`tp`/`ltp` are `Optional[float]` server-side and *will* be `null`; `NaN` must never reach `priceToCoordinate`.
- **Never render a partial suggestion.** Missing `tp` → hide the TP pill, keep the rest. Missing `entry` → hide the whole widget. Explicit per-field decisions, no `?? 0`.
- Poll only when the tab is visible (`document.visibilityState`) and the market is open (`services/price_action/market_hours.py` already knows).

### 3.5 The Trade button

```ts
POST /v1/paper/manual/order
{ direction, lots, order_type: 'MARKET', strike, option_type, sl, tp, strategy: 'chart-widget' }
```

**Reliability Requirements — R-A3 (highest-stakes code in the project)**
- **Idempotency key** on every submit (`clientOrderId = uuid`). A double-click, a retry, or a flaky network must not place two orders. If the backend doesn't dedupe yet, add it there — this is a backend change, and it is required, not optional.
- **Disable-on-submit, always.** Button → `pending` on click, re-enabled only on a terminal response. No exceptions.
- **Never auto-retry a POST.** Ambiguous timeout → show `Unknown — check positions`, link to the positions view. An automatic retry on an order endpoint can double a position; that is the single worst failure mode this system has.
- **Confirm step** showing strike, side, lots, entry, SL, TP, and computed risk in ₹, before anything is sent. Small modal or a two-stage button. Cheap to build; prevents the expensive mistake.
- **Freeze the suggestion on hover/focus of the Trade button.** Levels must not shift under the cursor between the decision and the click. This is a correctness requirement, not polish.
- **Reject stale submits.** Stamp the suggestion with the price it was computed at; if live price has moved more than a configured slippage tolerance since, block and re-prompt.
- Failure → inline error on the card with the server's message, and the widget stays usable. Never a silent `.catch(() => {})` — the existing `TradeRecommendationLine.tsx:14` swallows errors, and that pattern must not be copied here.

### 3.6 Drag-to-adjust

Reuse the proven approach in `LiveOIChart.tsx:753+`: capture-phase listener on the container, hit-test against `priceToCoordinate` of each level within `DRAG_HIT_PX`, `stopPropagation()`, disable `handleScroll`/`handleScale` for the drag, restore on mouseup. For a *pre-trade* suggestion the drag pins the level locally; for an *open position* it calls `POST /v1/paper/position/risk` on release.

**Reliability Requirements — R-A4**
- Pointer capture, not window listeners — no leaks, no lost-mouse-outside-window.
- **A poll landing mid-drag must not yank the line.** The existing code already handles this (`dragRef.current?.positionId === pos.id`); replicate exactly.
- Always restore `handleScroll`/`handleScale` in a `finally`. If a drag throws and leaves the chart unpannable, the whole app looks broken.
- Snap to tick size; validate SL/TP stay on the correct side of entry; reject and revert an invalid drag with a visible reason.
- Optimistic UI, **but reconcile**: if the server rejects the new level, snap back and say why.

### 3.7 Track A phases

| # | Deliverable | Reliability gate | Est. |
|---|---|---|---|
| **A1** | `TradeWidgetLayer` + `useChartAnchor` + static mock suggestion. Pills and card render at hardcoded prices, follow pan/zoom/scale perfectly. | R-A1 met; 0 dropped frames while panning; nothing rendered off-screen | 1 day |
| **A2** | Visual polish to match the reference image: pills, card, Trade button, hover/glow, collapse, `×`. | Renders identically at 80%/100%/150% zoom, dpr 1 and 2; no layout shift | 1 day |
| **A3** | `useLiveSuggestion` — real data from `/recommend` + `/chart/state`. Entry rides live price; levels update with hysteresis. | R-A2 met; survives API down, API slow, `null` fields, market closed | 1 day |
| **A4** | Trade button → `POST /manual/order`, with confirm, idempotency, freeze-on-hover. | R-A3 met **in full**; double-click test placed exactly one order | 1 day |
| **A5** | Drag-to-adjust TP/SL on both suggestions and open positions. | R-A4 met | 0.5 day |
| **A6** | Hardening pass: the §7 checklist, the §9 test matrix, a full trading-session soak. | All of §7 | 1 day |

**Track A total ≈ 5.5 days.**

---

## 4. Track B — Chrome extension (SECONDARY)

For charts we don't own: `tradingview.com`, Kotak Neo web, Dhan, etc. Build **after** Track A, reusing the same backend and the same visual design.

### 4.1 Verified research — tradingview.com

I inspected a live `tradingview.com/chart/` page. These are measured facts.

- The chart is **same-document** (no iframe); 7 canvases; **candles are canvas-only** — no per-candle DOM, so pixel positions must be computed, never read.
- **The price axis is also canvas** — no DOM text fallback for the scale. The **legend is DOM** (`"O 309.36 H 311.71 L 305.67 C 309.73"`), usable as a fallback for *values* but not for pixel mapping.
- `window.TradingViewApi` exists and works:

```js
const chart = window.TradingViewApi.activeChart();
const pane  = chart.chartWidget().paneWidgets()[0];
const scale = pane.state().defaultPriceScale();
scale.priceToCoordinate(100);          // → 1639.32   ✅ verified
scale.coordinateToPrice(y);            // inverse, for drag

const ts = chart.chartWidget().model().model().timeScale();
ts.indexToCoordinate(ts.visibleBarsStrictRange().lastBar());   // → 1106  ✅ verified

const bars = chart.chartWidget().model().model().mainSeries().bars();
bars.valueAt(bars.lastIndex());   // → [1785936600, 309.36, 311.71, 305.67, 309.61, 23707268] ✅

pane.canvasElement().getBoundingClientRect();   // {x:56, y:42, w:1109, h:611.33} — pane→viewport offset
chart.onVisibleRangeChanged() / onSymbolChanged() / onIntervalChanged() / onDataLoaded()
chart.createShape({time, price}, {shape:'horizontal_line'})    // native lines, if we want them
```

So the same `viewportX = paneRect.x + indexToCoordinate(i)`, `viewportY = paneRect.y + priceToCoordinate(p)` formula works. **Feasible — but every one of those names is undocumented and minified (the widget class came back as `Hp`). TradingView can rename any of it in any deploy.** That is the reliability gap versus Track A, and no amount of care closes it.

### 4.2 Kotak Neo and other broker platforms

Kotak Neo's web platform uses **TradingView-powered charts** — i.e. the licensed *Advanced Charts* library, fed by Kotak's own datafeed. Kotak Neo is also a TradingView broker partner, so its users can already trade from tradingview.com charts.

For us this is **better than tradingview.com**, because embedded Advanced Charts exposes the library's **documented public API** (`widget.activeChart()`, `priceScale().priceToCoordinate()`) rather than site internals. Same story for Dhan and most Indian brokers.

**But it cannot be planned any further without a login.** Four questions decide the entire implementation and none can be answered from outside:

1. Is the chart in an **iframe**? (→ `all_frames: true`, cross-frame messaging, or a dead end)
2. Which global holds the widget? (`window.tvWidget`, a module-scoped var, or nothing reachable)
3. Does `widget.activeChart().priceScale().priceToCoordinate()` actually work there?
4. What does the DOM around the chart container look like, and how stable are its class names?

**→ B0: a 0.5-day discovery spike per platform, requiring a logged-in account.** Everything downstream depends on its output. Do not estimate Track B for a given broker before this spike runs.

### 4.3 Extension architecture (once B0 answers are in)

The critical structural decision: **quarantine everything fragile behind one interface.**

```ts
interface ChartBridge {
  isAvailable(): boolean;
  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
  timeToX(time: number): number | null;
  lastBar(): { time: number; close: number } | null;
  onChange(cb: (reason: 'range'|'symbol'|'interval'|'resize') => void): () => void;
}
```

Three implementations, one UI:
- `LightweightChartsBridge` — **Track A**, ~20 lines, documented API
- `TradingViewSiteBridge` — `window.TradingViewApi`, MAIN world
- `BrokerAdvancedChartsBridge` — per-broker, public library API

Chrome specifics: MV3, `minimum_chrome_version: 111`. `window.TradingViewApi` lives in the page's JS world, which content scripts **cannot** see — so we need a `world: "MAIN"` content script (manifest-declared, CSP-exempt) for the bridge, and a normal ISOLATED content script for the UI, talking over a nonced `window.postMessage` protocol. Injecting a `<script src>` tag will be blocked by the host CSP; don't try.

**Reliability Requirements — R-B1**
- **Capability probe on every page load.** Assert each bridge method exists *and* returns a plausible value (`priceToY(lastClose)` must land inside the pane rect). Log and report the result.
- **Graceful degradation is mandatory.** Probe fails → the widget does **not** disappear and does **not** show wrong prices. It falls back to a fixed, draggable, manual-mode panel with a visible "chart link unavailable" badge. The product degrades; it never lies and never crashes the host page.
- **Never throw into the host page.** Every bridge call wrapped; a bridge fault is a logged, contained event.
- Pin a `knownGoodHostBuild` marker and log mismatches so a vendor deploy is detectable within hours.
- Single-injection guard (`window` flag **and** a DOM-id check — they fail in different situations: SPA nav vs. service-worker restart vs. multiple tabs).
- Full teardown on disable/navigate: remove the host element, disconnect every observer, release every listener. Verified by toggling 20× and watching for listener/heap growth.

### 4.4 Track B phases

| # | Deliverable | Est. |
|---|---|---|
| **B0** | Discovery spike per target platform. **Needs a logged-in account.** | 0.5 day each |
| **B1** | MV3 skeleton: Vite + TS strict, manifest, ISOLATED + MAIN content scripts, Shadow DOM host, message bus, popup (enable/disable/reset/version), ESLint/Prettier. | 2 days |
| **B2** | Port the Track A widget into the Shadow DOM. Same design tokens, same markup. | 1 day |
| **B3** | `TradingViewSiteBridge` + capability probe + degradation path. | 2 days |
| **B4** | Backend connection from the service worker (host permissions bypass CORS for extension-origin fetches), auth token handling, Trade button wired to our wrapper API. | 1.5 days |
| **B5** | First broker bridge (Kotak Neo or Dhan) after its B0. | 2 days |

**Track B total ≈ 9 days** after Track A, plus 0.5/platform for discovery.

---

## 5. The Levels Engine (shared)

Your differentiator versus Zing is **no strategy catalogue** — instead of waiting for a setup to fire, entry rides live price and TP/SL are derived continuously from market structure. Much of this exists (`services/banknifty/levels.py`, `suggestion_engine.py`, `price_action/analyzer.py`, OI-derived S/R). What's needed is a single consolidated endpoint the widget can trust.

```
1. Ingest    live LTP + rolling OHLCV (200–500 bars, current TF)
2. Pivots    fractal swing highs/lows, lookback k (3 scalp / 5 higher TF)
3. Zones     cluster by proximity (tol = max(0.15%, 0.5×ATR14));
             score = touch count × recency decay × volume-at-level
             — fold in the existing OI support_strike/resistance_strike, which are
               often stronger levels than pure price pivots for index options
4. Select    TP = nearest strong zone beyond entry in direction
             SL = just past nearest opposing zone (buffer 0.25×ATR)
5. Floors    |entry−SL| ≥ slMin×ATR14 ;  |TP−entry| ≥ rrMin×|entry−SL|  (rrMin 1.5)
6. Snap      round to tick; nudge toward round-number magnets (NIFTY 50/100pt)
7. Emit      { entry, tp, sl, zoneRefs, confidence, computedAtPrice }
```

**Reliability Requirements — R-L1 — the make-or-break constraint**

With no strategy gate, levels recompute constantly. Done naively, the widget **jitters** and looks broken. Non-negotiable:

- **Hysteresis.** An emitted level is *sticky*: it moves only if the new value differs by `> max(2 ticks, 0.3×ATR)`, or price has traded through it.
- **Split cadences.** Entry marker = rAF-smooth (feels alive). TP/SL = recomputed at most every 500ms–1s and animated over 300ms, so a change reads as a *decision*, not noise.
- **Lock on interaction.** Hovering the Trade button or dragging a pill freezes auto-adjustment for that suggestion. (Also stated in R-A3 — it matters that much.)
- **Invalidation is explicit.** If price runs through the proposed SL before entry, mark the card `stale`; never silently re-derive under the user.
- **Determinism.** Same bars in → same levels out. No wall-clock, no `Math.random()`, no dependence on poll timing. Unit-testable against fixtures, and it must be tested that way.
- **Always emit a reason.** Every level carries which zone produced it, surfaced on hover. A number you can't explain is a number you won't trust at 9:20am.

---

## 6. Keeping the two tracks unified

Do these three things during Track A and Track B costs ~30% less:

1. **`ChartBridge` from day one.** Even in Track A where it's a 20-line wrapper over `series.priceToCoordinate`. The widget must never call lightweight-charts directly.
2. **Presentational components take props only.** `SuggestionCard` and `LevelPill` receive `{x, y, values, handlers}` and nothing else — no hooks, no fetching, no chart references. Then they drop into a Shadow DOM unchanged.
3. **Design tokens in one CSS file**, referenced by variable everywhere. Track B copies one file.

```
        ┌──────────────── shared ────────────────┐
        │  SuggestionCard   LevelPill   tokens.css │
        │  Suggestion types   levels contract      │
        └───────┬────────────────────────┬─────────┘
                │                        │
     LightweightChartsBridge      TradingViewSiteBridge / BrokerAdvancedChartsBridge
        (Track A, in-app)              (Track B, extension)
                │                        │
                └────────► FastAPI ◄─────┘
                     /chart/state, /recommend, /manual/order
                              │
                          BrokerPort → Kotak Neo / Upstox
```

---

## 7. Reliability engineering standard (applies to every phase)

You asked for reliability everywhere. This is the definition. Nothing merges without it.

### 7.1 Never display a number we can't vouch for
The failure mode that costs real money is a widget confidently showing a **stale or wrong price**. Ranked behaviour: **correct > visibly absent > visibly stale > silently wrong.** Every code path picks one of the first three.
- `priceToCoordinate` → `null` ⇒ hide. Never extrapolate.
- Data older than 15s or `is_fresh === false` ⇒ dim + `stale` badge + **Trade disabled**.
- `NaN`/`undefined`/`null` in any price field ⇒ that element does not render. No `?? 0`, ever.

### 7.2 No silent failures
`.catch(() => {})` is banned in this feature. Every failure does at least one of: surface in the UI, log with context, or trip the degradation path. (`TradeRecommendationLine.tsx:14` currently swallows errors — do not copy it, and fix it while we're there.)

### 7.3 Order-path safety (the one place a bug is expensive)
Idempotency key · disable-on-submit · **no auto-retry on POST** · confirm dialog with risk in ₹ · slippage guard · ambiguous-timeout → "check positions", never a retry.

### 7.4 Lifecycle correctness
Every `useEffect` returns a cleanup. Every listener/observer/rAF/interval is released. Must survive: React StrictMode double-mount, hot reload, symbol switch, timeframe switch, tab background/foreground, chart teardown mid-frame. **Test: switch symbols 50× and confirm listener count and heap are flat.**

### 7.5 Performance budget
Widget layer < 0.3 ms/frame. Zero DOM writes when the chart is still. No second rAF loop. Verified in the Performance panel, not by feel.

### 7.6 Degradation ladder — explicit, tested, per failure
| Failure | Behaviour |
|---|---|
| API unreachable | Last-known values dimmed + `stale`, Trade disabled, backoff retry, reconnect banner |
| API returns partial data | Render only the fields present; hide the rest individually |
| Chart not ready / torn down | Layer renders nothing, no throw, retries next frame |
| Price outside visible range | Element hidden; reappears on scroll-back |
| Market closed | Widget shows `Market closed`, Trade disabled |
| (Track B) bridge probe fails | Manual-mode fixed panel + badge; host page unaffected |
| Order rejected | Inline error with the server message; widget stays usable |

### 7.7 Test discipline
- Unit: levels engine against fixture bar sets (deterministic, §5 R-L1).
- Unit: every payload type guard, including `null`/`NaN`/missing-field cases.
- Integration: mock API — down, slow (5s), partial, malformed.
- Manual matrix: §9.
- **Soak: one full trading session, 9:15–15:30, with the DevTools console open. Zero errors, flat memory. This is the real acceptance gate for Track A.**

### 7.8 Observability
A `[TradeWidget]` namespaced logger, on in dev and behind a flag in prod. Log: every state transition, every degradation trip, every order submit/response with its idempotency key, bridge probe results. When something goes wrong at 9:20am you need the log, not a repro.

---

## 8. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 8.1 | **Widget jitter/flicker** from continuous recompute — the most likely thing to make this feel broken | **HIGH** | §5 R-L1: hysteresis, split cadences, interaction lock, animated transitions |
| 8.2 | **Stale price shown as live** → a trade on a bad number | **HIGH** | §7.1 ranked behaviour; `is_fresh`; staleness timer; Trade disabled when unsure |
| 8.3 | **Duplicate order** from double-click/retry | **HIGH** | R-A3: idempotency key, disable-on-submit, no auto-retry. Backend dedupe required. |
| 8.4 | Frame-rate damage to the chart | MED | R-A1: transform-only, sub-pixel skip, shared rAF loop, measured budget |
| 8.5 | **(Track B)** TradingView internals renamed by a deploy | **HIGH for B, N/A for A** | R-B1: probe + degradation + build marker. **This risk is the entire argument for doing Track A first.** |
| 8.6 | Regulatory / broker-policy | *Descoped by user* | Recorded for completeness: SEBI's retail-algo framework (Algo-ID from April 2026) and vendor ToS apply to public products. Personal use, own wrapper API, human clicks every order. Revisit only if this is ever distributed. |
| 8.7 | Delta-based premium↔spot projection drifts | MED | Already handled in `premiumToSpot`; keep returning `null` when greeks are absent (existing comment says a premium-only readout beats a made-up level — correct, keep it) |
| 8.8 | Widget overlaps chart UI / other overlays | LOW | z-index token, `pointer-events: none` on the layer and `auto` only on interactive children, collision nudge |

---

## 9. Manual test matrix (Track A)

| Scenario | Expected |
|---|---|
| Pan / zoom / Y-scale drag | Widget tracks price exactly, no lag, no jitter |
| Price scrolls out of view | Element hides cleanly; returns on scroll-back |
| Symbol switch (NIFTY ↔ BANKNIFTY) | Clean re-anchor, no ghost elements, no stale numbers |
| Timeframe switch | Same |
| API stopped mid-session | `stale` + dim + Trade disabled + backoff; recovers on restart |
| API slow (5s artificial delay) | No flicker, no out-of-order overwrite |
| `sl`/`tp` return `null` | Those pills hide; card still works |
| Double-click Trade | **Exactly one order** |
| Trade with a rejecting backend | Inline error; widget still usable |
| Drag TP into an invalid position | Rejected with a visible reason; reverts |
| Poll lands mid-drag | Dragged line does not jump |
| Market closed | `Market closed`, Trade disabled |
| Browser zoom 80 / 100 / 150% | Correct positioning at all |
| Window resize, panel collapse | Re-anchors correctly |
| Tab backgrounded 10 min | Polling paused; correct on return |
| Switch symbol 50× | Flat listeners, flat heap |
| Full session soak | Zero console errors, flat memory |

---

## 10. Estimates

| | Est. |
|---|---|
| **Track A (in-app, primary)** — A1…A6 | **≈ 5.5 days** |
| Levels Engine consolidation endpoint (if the existing services need a unified `/levels`) | 2–4 days |
| Track B0 discovery spike (per platform, needs login) | 0.5 day each |
| **Track B (extension)** — B1…B5 | **≈ 9 days** |

**First working widget on your own chart: ~4 days** (A1–A4).

---

## 11. Open questions

1. **Confirm Track A first.** Building on `quantboard-pandapath` rather than starting with the extension — this is my strong recommendation and it changes the whole sequence.
2. **Which chart page is the target?** `LiveOIChart.tsx` (the full one, on `/live-oi`) or `TradingChart.tsx`? I'd start with `LiveOIChart` since the anchor loop and drag logic already live there.
3. **Does `/v1/paper/recommend` already give a *continuous* suggestion, or only when `trade_recommended === true`?** Your "no strategy" model needs levels available **at all times**, not just when a setup fires. If it's gated, we need either a flag or a new always-on `/levels` endpoint — this may be the largest backend item, and it's the one I'd want to check next.
4. **Real or paper by default?** The Trade button can hit `/v1/paper/manual/order` (paper) or `/v1/execution/execute` (live). I recommend paper as the default with an explicit, visually distinct live toggle.
5. **Does `POST /manual/order` dedupe by client key today?** If not, that's a required backend change before A4 (R-A3).
6. **Track B priority order** once A ships: tradingview.com, Kotak Neo, or Dhan? And can you get me a logged-in session for the B0 spike?
7. **Multi-position display.** With several open positions plus a live suggestion, do we show every widget, or only the suggestion plus the selected position? Affects the collision-handling design.

---

## 12. Recommendation

**Start with Track A, phase A1.**

You already own a working chart, a working levels/suggestion backend, a working order wrapper, and — critically — working `priceToCoordinate` anchoring and drag-to-adjust code. The Zing-style widget is a **presentation layer over things that already run**. That is why it's ~4 days to something real, and it's why it can be made genuinely reliable: every moving part is code we control and a library we pin.

The extension is worth building, and §4 has the verified research to build it — I confirmed the TradingView internals work end to end. But it will always carry a failure mode Track A doesn't: an undocumented API that a vendor can rename without telling us. Since you've said reliability is the priority, that ordering follows directly.

Three things to settle before A1 starts: confirm the target chart page (Q2), check whether `/recommend` can produce continuous always-on levels (Q3 — most likely to need backend work), and decide paper-vs-live default (Q4).
