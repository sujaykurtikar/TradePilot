# TradePilot — Chrome Extension Implementation Plan

**Status:** Planning only. No implementation started.
**Date:** 2026-08-05
**Decision:** **Chrome extension is Phase 1.** Targets: **Kotak Neo (priority)** and **TradingView.com**. The in-app overlay on `quantboard-pandapath` is deferred to Phase 2 — it is *not* part of the first delivery.

**Goal:** A Zing-style on-chart widget — TP pill above, `Suggested / <strike> / [Trade]` card riding the live price, SL pill below — injected onto charts we don't own, with one-click execution through our own wrapper API.

**Overriding requirement: RELIABILITY.** Every phase carries an explicit *Reliability Requirements* block. §7 defines the standard they are measured against. Nothing merges without meeting it.

**Noted once, not treated as a blocker:** I recommended building on our own chart first because vendor internals can break without warning (§8.1). That recommendation was considered and overruled — extension first. The plan below therefore invests heavily in the **capability probe + degradation ladder** (§5.4, R-P2), which is how we make an inherently fragile integration behave predictably. SEBI/vendor-policy constraints are descoped per your decision (personal use, own wrapper API) — recorded once in §8.6.

**Update since the previous revision:** both TradingView.com and Kotak Neo are now verified working (§4.1, §4.2). The Kotak probe — run live via Claude in Chrome on your logged-in session — turned up a correction to something I'd told you: Kotak doesn't use a separately-documented "Advanced Charts" API as I assumed; it embeds TradingView's own internal site widget (three-level iframe nesting, innermost frame is a `blob:` URL). That's good news for engineering effort — one bridge class covers both hosts — though it means Kotak carries the same undocumented-internals risk as tradingview.com, not less, as I'd originally claimed.

---

## 1. The plan in one page

```
Phase 1  ── CHROME EXTENSION ────────────────────────────────────────────
  P0  Discovery      TradingView ✅ verified  ·  Kotak ✅ verified (§4.2 — good news, same API family)
  P1  Skeleton       MV3 + Vite + TS strict, Shadow DOM, messaging, popup
  P2  ChartBridge    interface + shared TradingViewInternalApiBridge (verified working)
  P3  Widget UI      TP pill / Suggested card / SL pill — matches the design
  P4  Anchoring      widget tracks live price + levels through the bridge
  P5  Data           service worker → our FastAPI → suggestion + levels
  P6  Trade          entry order via our wrapper; TP/SL enforced by our engine
  P7  Kotak config   frame-injection + symbol map on the SAME bridge class
  P8  Hardening      §7 checklist + full-session soak
                                                          ≈ 11–13 days

Phase 2  ── IN-APP OVERLAY (deferred) ───────────────────────────────────
  Port the same widget into quantboard-pandapath's LiveOI chart.
  ~3 days, because P3/P4/P5/P6 are already built and reusable.
```

**Key sequencing decision, updated:** both discovery targets are now verified (§4.1, §4.2), and **the Kotak probe turned up something better than expected — Kotak's chart is the same internal API family as tradingview.com, not a separate documented one.** That means P2 and P7 are no longer two separate adapters; they're one bridge implementation with per-host configuration (§5.1). P1 starts immediately either way; P7's remaining work is narrower than originally scoped — the frame-injection mechanics (§4.2) rather than a whole second API surface.

---

## 2. What we are building on top of (already exists — do not rebuild)

`C:\Users\sujay\CKProjects\quantboard-pandapath` already provides the entire backend. The extension is a **client** of it.

| Endpoint | Role in the extension |
|---|---|
| `GET /v1/paper/chart/state` | spot, `atm_strike`, `strike_interval`, `lot_size`, `expiry`, `is_fresh`, open `positions[]` with `sl`/`tp`/`entry_spot`/`delta`/`unrealized_pnl` |
| `GET /v1/paper/recommend` | `direction`, `recommended_symbol`, `recommended_option_type`, `recommended_ltp`, `sl`, `tp`, `composite_score`, `rationale[]` |
| `POST /v1/paper/manual/order` | **the Trade button** — `{direction, lots, order_type, strike, option_type, sl, tp, strategy}` |
| `POST /v1/paper/position/risk` | drag-to-adjust TP/SL on an open position |
| `POST /v1/paper/manual/square_off` / `/flatten` | exits |
| `POST /v1/execution/execute` / `/halt` / `/resume` | live execution + kill switch |

Order path: `FastAPI → packages/contracts/broker.py (BrokerPort) → broker_kotak_neo / broker_upstox`. The extension **never** talks to a broker. It talks to our API. Adding a broker later is one adapter file, no extension change.

Exit management: `services/trade_management/manager.py` — a 9-stage exit framework (`EXIT_HARD_STOP`, `EXIT_TIME_STOP`, `EXIT_PARTIAL_T1`, …) already evaluated against live price. **This is what enforces our TP/SL** — see §3.

Levels: `services/banknifty/levels.py`, `suggestion_engine.py`, `services/price_action/`, OI-derived S/R.

---

## 3. Critical design correction — TP and SL are OURS, not the broker's

You observed that charts won't let you set SL and TP together. That is not a Kotak bug and not a chart limitation. It is structural across Indian brokers:

- The order type that carries a target *and* a stop as linked OCO legs is the **Bracket Order**.
- Brokers killed BO around **March 2020**: in volatile conditions both legs could fire — price ticks the stop, then instantly the target, both execute, and you're left holding an unintended *short*. SEBI's July 2020 peak-margin rules then removed the leverage that made BO commercially worthwhile.

**Consequence for this design:**

```
[Trade] click  →  POST /manual/order      — ENTRY ONLY. Plain MARKET/LIMIT.
TP / SL        →  our levels, stored with the position, NOT sent as broker legs
Enforcement    →  services/trade_management/manager.py monitors live price
                  and fires square_off when either level is touched
```

This is almost certainly what Zing does too — their screenshot shows both TP and SL, which no Indian broker will accept as a single native order.

**It is an advantage, not a workaround.** Broker brackets are rigid. Our engine already does trailing, time stops, and partial exits — things a bracket order cannot express.

**Reliability Requirements — R-OCO**
- The widget must never imply the broker is holding the stop. Label it as *our* managed exit.
- If our backend is unreachable while a position is open, **the position is unprotected.** The widget must say so, loudly and unmissably — a red banner, not a subtle tint. This is the single most dangerous state in the system.
- Exit monitoring lives in the backend, never in the extension. A closed browser tab must never disable a stop-loss. Non-negotiable.
- Extension shows the *engine's* view of SL/TP, never a locally-cached guess.

---

## 4. Verified research

### 4.1 TradingView.com — CONFIRMED WORKING

I inspected a live `tradingview.com/chart/` page. Measured, not assumed:

- Chart is **same-document** (no iframe). 7 canvases. **Candles are canvas-only** — no per-candle DOM, so pixel positions must be computed, never read.
- **Price axis is canvas too** — no DOM fallback for the scale. The **legend is DOM** (`"O 309.36 H 311.71 L 305.67 C 309.73"`) — usable for *values*, not for pixel mapping.

```js
const chart = window.TradingViewApi.activeChart();
const pane  = chart.chartWidget().paneWidgets()[0];
const scale = pane.state().defaultPriceScale();
scale.priceToCoordinate(100);        // → 1639.32   ✅ verified
scale.coordinateToPrice(y);          // inverse, for drag-to-set-level

const ts = chart.chartWidget().model().model().timeScale();
ts.indexToCoordinate(ts.visibleBarsStrictRange().lastBar());   // → 1106  ✅ verified

const bars = chart.chartWidget().model().model().mainSeries().bars();
bars.valueAt(bars.lastIndex());
// → [1785936600, 309.36, 311.71, 305.67, 309.61, 23707268]     ✅ verified

pane.canvasElement().getBoundingClientRect();   // {x:56,y:42,w:1109,h:611.33}
chart.onVisibleRangeChanged() / onSymbolChanged() / onIntervalChanged() / onDataLoaded()
```

Formula: `viewportX = paneRect.x + indexToCoordinate(i)`, `viewportY = paneRect.y + priceToCoordinate(p)`.

⚠️ Every one of those names is **undocumented and minified** (the widget class came back as `Hp`). TradingView can rename any of it in any deploy. This is why P2 ships a probe and a degradation path *before* anything depends on it.

### 4.2 Kotak Neo — CONFIRMED WORKING (correction to my earlier assumption)

**Probed live, via Claude in Chrome, on the Kotak Neo "Trade from Charts" page, read-only (no order controls touched).** Full output below. This corrects something I told you earlier: I had assumed Kotak licenses TradingView's separate **Advanced Charts** product, with its own documented public API. **That's wrong.** The probe shows Kotak has actually embedded **TradingView's own website chart widget** — the same internal, undocumented object family as `tradingview.com` itself (§4.1: `activeChart()` → `chartWidget()` → `paneWidgets()` → `state().defaultPriceScale()`). The global is just named `tradingViewApi` here instead of `TradingViewApi`.

**Net effect: better than expected.** One bridge implementation now covers both hosts (§5.1) — same method chain, same fragility profile, same mitigation. The finding does **not** make Kotak more stable than tradingview.com as I originally claimed; it makes the two *identical* in stability, and shareable in code.

**Frame structure — the one real engineering wrinkle:**

```
top document (trade.kotakneo.com/TradeFromCharts/…)
  └─ iframe: https://trade.kotakneo.com/static/trading-view-v3/index.html
       └─ iframe: blob:https://trade.kotakneo.com/<session-uuid>   ← the widget lives HERE
```

Confirmed via the probe: `widgetGlobals` and `canvases` were empty at the top frame and the first iframe; only the innermost blob iframe returned a populated `tradingViewApi` object, real canvases (`chart-gui-wrapper`, `price-axis`), and working coordinate math:

```json
{
  "symbol": "NSE_CM|NIFTY 50",
  "resolution": "1",
  "priceToCoordinateSample": 104.00434221146395,
  "coordinateToPriceSample": 24601.532614605214,
  "paneRect": { "x": 9, "y": 42, "width": 721, "height": 396, "right": 730, "bottom": 438 }
}
```

Both conversions returned real, self-consistent numbers against a live NIFTY chart at ~24,600–24,625 — the same class of proof as §4.1. **The API works.**

**Three engineering consequences from the frame nesting:**

1. **Both our MAIN-world bridge and our ISOLATED-world widget script must target the innermost blob iframe directly**, not the top document. This actually *simplifies* the architecture over what I'd planned: since both scripts run in the same frame, they can coordinate with the ordinary same-frame `window.postMessage` protocol from §4.1 — **no cross-frame messaging needed.** The Shadow DOM host mounts inside that iframe's own document, and `paneRect` is used as-is with no outer-iframe offset math.

2. **Matching a `blob:` URL in the manifest needs one of two mechanisms, to be validated during P1 build:**
   - A direct match pattern: `"matches": ["blob:https://trade.kotakneo.com/*"]` with `all_frames: true` — Chrome supports `blob:`-scheme match patterns keyed on the origin that created the blob, and the trailing `*` covers the per-session UUID.
   - If that proves unreliable, the manifest V3 fallback field `match_origin_as_fallback: true` on the content-script entry tells Chrome to check the *creating* origin (`https://trade.kotakneo.com`) for frames whose own URL can't be matched directly (the documented use case is exactly `blob:`/`data:`/`about:blank` frames).
   Both are standard, documented MV3 mechanisms — I haven't run a live extension against this specific page yet, so this is the concrete P7 build task, not a remaining unknown about *whether* it's possible.

3. **One more thing worth checking before P7, and it's yours to check (I can't reach the page):** does the blob iframe (or the middle static iframe) carry a `sandbox` attribute? A `sandbox` without `allow-scripts allow-same-origin` can block content-script injection or same-origin `postMessage` entirely. One-liner, read-only, run in the *top* frame console:
   ```js
   [...document.querySelectorAll('iframe')].map(f => ({src: f.src.slice(0,60), sandbox: f.getAttribute('sandbox')}))
   ```
   Then the same query run one level down (switch the console's frame dropdown to the first iframe) for its child. If either shows a `sandbox` value, paste it back — it would change how P7 injects.

**Also confirmed, feeding directly into P5's symbol-mapping requirement:** Kotak's own symbol string is `"NSE_CM|NIFTY 50"` — visibly different from whatever `quantboard-pandapath`'s backend calls it (`NIFTY`, `NSE:NIFTY`, or similar). This is a concrete, real entry for the mapping table in §10 Q7, not a hypothetical.

**P7 is now a scoped, bounded task** — frame-injection mechanics + one symbol-mapping entry — rather than an unknown second API to reverse-engineer.

---

## 5. Architecture

### 5.1 Execution contexts

```
┌─ MAIN world content script ── bridge.js ──────────────────────┐
│  The ONLY code that touches host-page chart internals.        │
│  TradingViewInternalApiBridge — ONE class, per-host config     │
│  (candidate global names + frame-match pattern), since §4.2    │
│  confirmed Kotak exposes the same method chain as TV itself.   │
│  Small, defensive, disposable. Fix here when a vendor deploys. │
└──────────────── window.postMessage (nonced, same-frame) ──────┘
┌─ ISOLATED world content script ── content.js ─────────────────┐
│  Shadow DOM host · widget UI · anchoring · drag · storage      │
│  Knows nothing about TradingView or Kotak. Talks to a bridge.  │
└──────────────── chrome.runtime messaging ─────────────────────┘
┌─ Service worker ── background.js ─────────────────────────────┐
│  All network. host_permissions bypass CORS for our API.        │
│  Poll/stream suggestions · submit orders · idempotency keys    │
└───────────────────────── HTTP ────────────────────────────────┘
                    our FastAPI → BrokerPort → Kotak Neo
```

Why the MAIN/ISOLATED split: `window.TradingViewApi` and `window.tvWidget` live in the **page's** JS world. Content scripts run in an **isolated** world and cannot see them. A manifest-declared `world: "MAIN"` content script (Chrome 111+) is CSP-exempt and solves it. Injecting a `<script src>` tag will be blocked by the host CSP — don't try.

**This split is the most important decision in the project.** It quarantines all reverse-engineered surface behind one replaceable file. Enforced by lint: nothing outside `src/bridge/**` may reference `TradingViewApi` or `tvWidget`.

### 5.2 The ChartBridge interface

```ts
interface ChartBridge {
  readonly id: 'tradingview-site' | 'kotak-neo' | 'lightweight-charts';
  isAvailable(): boolean;
  probe(): ProbeResult;                       // capability self-test, see §5.4
  priceToY(price: number): number | null;     // viewport px, null = off-screen
  yToPrice(y: number): number | null;
  timeToX(time: number): number | null;
  lastBar(): { time: number; close: number } | null;
  symbol(): string | null;
  onChange(cb: (r: 'range'|'symbol'|'interval'|'resize') => void): () => void;
}

// Updated per §4.2: tradingview-site and kotak-neo share ONE implementation.
interface InternalApiHostConfig {
  id: 'tradingview-site' | 'kotak-neo';
  frameMatch: string;                // e.g. 'blob:https://trade.kotakneo.com/*'
  candidateGlobals: string[];        // e.g. ['tradingViewApi', 'TradingViewApi']
  symbolMap: Record<string, string>; // e.g. {'NSE_CM|NIFTY 50': 'NIFTY'}
}
```

Two implementations, one widget: `TradingViewInternalApiBridge` (config-driven, covers both tradingview.com and Kotak Neo — confirmed identical method chain in §4.1/§4.2) and Phase 2's `LightweightChartsBridge` (~20 lines over the documented public API — why the in-app port later costs ~3 days, not 12).

### 5.3 Folder structure

```
TradePilot/
├── src/
│   ├── manifest.ts                 # typed manifest source of truth
│   ├── background/
│   │   ├── index.ts                # SW entry, lifecycle
│   │   ├── ApiClient.ts            # our FastAPI; abort, backoff, idempotency
│   │   ├── OrderService.ts         # ⚠ the money path — see R-P4
│   │   └── MessageRouter.ts
│   ├── bridge/                     # ⚠ ALL fragile code lives here
│   │   ├── mainWorld.ts            # MAIN-world entry; picks host config by location
│   │   ├── ChartBridge.ts          # the interface
│   │   ├── adapters/
│   │   │   ├── TradingViewInternalApiBridge.ts   # shared: TV site + Kotak (§4.2)
│   │   │   ├── hostConfigs.ts                    # per-host: frameMatch, globals, symbolMap
│   │   │   └── LightweightChartsBridge.ts        # Phase 2 only
│   │   ├── CapabilityProbe.ts
│   │   └── protocol.ts             # nonced postMessage envelope (same-frame, see §4.2)
│   ├── content/
│   │   ├── index.ts                # ISOLATED entry
│   │   ├── Bootstrap.ts            # ready-gate → inject → observe → teardown
│   │   ├── ChartReadyDetector.ts
│   │   ├── SpaNavigationObserver.ts
│   │   └── InjectionGuard.ts
│   ├── widget/
│   │   ├── ShadowHost.ts
│   │   ├── WidgetRoot.ts
│   │   ├── components/  SuggestionCard · LevelPill · DragHandle · IconButton
│   │   ├── managers/    AnchorManager · DragManager · StateManager
│   │   └── styles/      tokens.css · widget.css · animations.css
│   ├── core/
│   │   ├── messaging/   MessageBus · messages.ts · guards.ts
│   │   ├── storage/     StorageManager · schema.ts · migrations.ts
│   │   └── state/       Store.ts
│   ├── models/          Suggestion · Position · ChartContext
│   └── utils/           logger · result · dom · env
├── popup/               enable · disable · reset position · API status · version
└── dist/                the unpacked extension
```

### 5.4 The capability probe — how we make a fragile integration predictable

This is the mitigation for building on vendor internals. It runs on **every page load**, before anything depends on the bridge.

```
1. Does each ChartBridge method exist?
2. Does priceToY(lastBarClose) return a number INSIDE the pane rect?    ← the real test
3. Does yToPrice(priceToY(p)) round-trip back to p within 1 tick?       ← catches silent breakage
4. Does timeToX(lastBarTime) land inside the pane width?
5. Report ProbeResult → content script → popup badge → log
```

A method that exists but returns garbage is more dangerous than one that's missing. Checks 2 and 3 are what catch that.

**Reliability Requirements — R-P2 (the degradation ladder)**

| Probe result | Behaviour |
|---|---|
| All pass | Full anchoring. Widget rides price. |
| Coordinate methods fail | **Manual mode**: fixed, draggable panel with a visible "chart link unavailable" badge. Suggestion values still shown and still tradeable — they come from our API, not the chart. |
| Bridge entirely absent | Widget does not mount. Popup says why. Host page untouched. |

The product degrades. **It never lies, never shows a wrong price, and never breaks the host page.** Additional requirements:
- Every bridge call wrapped — a bridge fault is a logged, contained event, never a throw into the host page.
- Pin a `knownGoodHostBuild` marker; log mismatches so a vendor deploy is detectable within hours rather than from a bad fill.
- Probe result surfaced in the popup so you can see the integration's health at a glance.

---

## 6. Phase 1 — detailed phases

### P0 — Discovery
TradingView ✅ complete (§4.1). Kotak ✅ complete (§4.2) — same internal API family, confirmed working, frame nesting mapped. **Both done. Remaining open item is the `sandbox` attribute check (§4.2), yours to run.**
**Est: complete**

### P1 — Extension skeleton
MV3 manifest (`minimum_chrome_version: 111`), Vite + TypeScript strict, two build configs (content scripts must be **IIFE** — MV3 content scripts don't support ESM; the service worker is `type: module`). Shadow DOM host. Typed message bus. Storage with schema + migrations scaffold. Popup: enable / disable / reset position / API status / version. ESLint flat config + Prettier + `import/no-restricted-paths` enforcing the bridge quarantine.

Manifest essentials:
```jsonc
"permissions":      ["storage", "scripting", "activeTab"],
"host_permissions": ["https://*.tradingview.com/*",
                     "https://*.kotaksecurities.com/*",
                     "http://127.0.0.1:8000/*"],       // our FastAPI
"content_scripts":  [
  { matches: ["https://www.tradingview.com/chart/*"],
    world: "ISOLATED", js: ["content.js"] },
  { matches: ["https://www.tradingview.com/chart/*"],
    world: "MAIN",     js: ["bridge.js"] },
  { matches: ["https://trade.kotakneo.com/*", "blob:https://trade.kotakneo.com/*"],
    all_frames: true, match_origin_as_fallback: true,
    world: "ISOLATED", js: ["content.js"] },
  { matches: ["https://trade.kotakneo.com/*", "blob:https://trade.kotakneo.com/*"],
    all_frames: true, match_origin_as_fallback: true,
    world: "MAIN",     js: ["bridge.js"] }
]
```
Kotak's entries carry `all_frames: true` and target the blob iframe directly (§4.2); TradingView's don't need either, since its chart is same-document.

**R-P1**
- Single-injection guard: a `window` flag **and** a DOM-id check — they fail in different situations (SPA nav vs. service-worker restart vs. multiple tabs).
- SPA navigation: patch `pushState`/`replaceState`, listen to `popstate`, plus a `MutationObserver` backstop. Both targets are SPAs.
- Full teardown on disable/navigate: remove host, disconnect every observer, release every listener. **Verified by toggling 20× and watching listener count and heap stay flat.**
- `all_frames: false` for TradingView (same-document chart); `all_frames: true` + `match_origin_as_fallback: true` for Kotak, confirmed necessary by §4.2's frame nesting.

**Est: 2 days**

### P2 — ChartBridge + TradingViewInternalApiBridge + probe
The interface, the MAIN-world entry, and the **shared** adapter over the verified calls in §4.1/§4.2 — built config-driven from the start (`hostConfigs.ts`: candidate globals, frame match, symbol map) so tradingview.com works immediately and Kotak only needs its config entry plus the frame-match wiring, not new logic. The capability probe. The nonced postMessage protocol (namespace + per-session nonce; verify `event.source === window` and `event.origin === location.origin` — a page script can post into the isolated world; same-frame for both hosts, per §4.2).

**R-P2** as specified in §5.4, in full. **This ships before anything depends on the bridge, not after.**

**Est: 2 days** (covers tradingview.com fully; Kotak's config entry is written here too, its frame-injection wiring finishes in P7)

### P3 — Widget UI
```
┌──────────────────────────┐
│  ⠿  TP  24126.2      ×   │   LevelPill variant="tp"
└──────────────────────────┘
    ┌──────────────────────┐
    │ ⚡ Suggested          │
    │   24120 CE  [ Trade ]│   SuggestionCard
    └──────────────────────┘
┌──────────────────────────┐
│  ⠿  SL  24116.2      ×   │   LevelPill variant="sl"
└──────────────────────────┘
```
Shadow DOM, CSS custom properties, dark theme, blur, rounded, glow on hover, fade+scale mount. Collapsible to a single puck. Draggable via pointer capture. Position and collapse state persisted.

**R-P3**
- **Three independently-positionable elements**, not one rigid flex column — in P4 they move to their own price levels. This is the one decision that is expensive to retrofit.
- `transform: translate3d` only. **Never** `top`/`left` — that forces layout inside the host's render loop and will visibly stutter the chart.
- `pointer-events: none` on the layer, `auto` only on interactive children — never block chart interaction.
- Tabular-lining numerals so digits don't jitter when values update live.
- `@media (prefers-reduced-motion: reduce)` → all durations 1ms.
- Correct at browser zoom 80/100/150% and dpr 1/2/3.
- Keyboard: Trade is a real `<button>`; arrow-key drag alternative on the handle.

**Est: 2 days**

### P4 — Anchoring
One `requestAnimationFrame` loop for the whole widget, driven by `bridge.onChange` plus a per-frame sync.

```ts
const y = bridge.priceToY(level.price);
const x = level.pinRight ? paneRect.right - GUTTER : bridge.timeToX(level.time);
if (y == null || x == null) { hide(el); return; }        // off-screen → hide, never guess
if (Math.abs(y - last.y) < 0.5 && Math.abs(x - last.x) < 0.5) return;   // sub-pixel → skip
el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
```

**R-P4a**
- `null` ⇒ **hide the element**. Never extrapolate, never reuse a stale coordinate. A widget showing a wrong price is worse than one showing nothing.
- Sub-pixel skip so a still chart does zero DOM writes. Idle CPU ≈ 0%.
- Guard every frame against a torn-down chart.
- One rAF loop. A second one is a defect.
- **Budget: < 0.3 ms/frame**, verified in the Performance panel, not by feel.

**Est: 1.5 days**

### P5 — Data
Service worker polls `GET /chart/state` and `GET /recommend`, merges, validates, pushes to the content script.

**R-P5**
- **Single in-flight request per endpoint** — `AbortController` cancels the previous. A slow response must never overwrite a newer one.
- **Staleness is visible.** `is_fresh === false`, or last success > 15s ago ⇒ widget dims, shows `stale`, **Trade disabled**.
- **Backoff:** 5s → 10s → 20s → 30s cap, reset on first success. Never hammer a dead API for an hour.
- **Type-guard every payload at the boundary** — a guard, not a cast. `sl`/`tp`/`ltp` are `Optional[float]` server-side and *will* be `null`. `NaN` must never reach `priceToY`.
- **Never render a partial suggestion.** Missing `tp` ⇒ hide the TP pill, keep the rest. Missing entry ⇒ hide the widget. Explicit per-field decisions. **No `?? 0`, ever.**
- Poll only when the tab is visible and the market is open (`services/price_action/market_hours.py` already knows).
- **Symbol mapping** per surface: the chart's symbol string (`NIFTY`, `NSE:NIFTY`, Kotak's own token) → our instrument. Explicit map, and an **unmapped symbol hides the widget rather than guessing**.

**Est: 1.5 days**

### P6 — The Trade button
```
POST /v1/paper/manual/order
{ direction, lots, order_type:'MARKET', strike, option_type, sl, tp,
  strategy:'chart-widget', clientOrderId:<uuid> }
```
Per §3: this places the **entry only**. `sl`/`tp` are recorded as *our* managed levels and enforced by `trade_management`.

**R-P6 — highest-stakes code in the project**
- **Idempotency key** (`clientOrderId`) on every submit. A double-click, a retry, or a flaky network must not place two orders. **If the backend doesn't dedupe today, that is a required backend change before P6 — not optional.**
- **Disable-on-submit, always.** `pending` on click, re-enabled only on a terminal response.
- **Never auto-retry a POST.** Ambiguous timeout ⇒ `Unknown — check positions` with a link. An auto-retry on an order endpoint can double a position; that is the worst failure mode this system has.
- **Confirm step** showing strike, side, lots, entry, SL, TP, and risk in ₹ before anything is sent.
- **Freeze the suggestion on hover/focus of Trade.** Levels must not shift between the decision and the click. Correctness, not polish.
- **Slippage guard:** stamp the suggestion with the price it was computed at; if live price has moved beyond tolerance, block and re-prompt.
- **Paper is the default.** Live requires an explicit, visually distinct toggle.
- Failure ⇒ inline error with the server's message; widget stays usable. **No silent `.catch(() => {})`** (§7.2).
- Plus **R-OCO** (§3) in full — especially the unmissable warning when the backend is unreachable while a position is open.

**Est: 2 days**

### P7 — Kotak Neo frame wiring
Per §4.2, this is narrower than originally scoped: the API itself is already covered by P2's shared bridge. What's left is purely the injection mechanics —
- Wire the `blob:` match pattern + `match_origin_as_fallback` content-script entries (§manifest above) and confirm the content script actually lands inside the innermost blob iframe, not the middle static-HTML iframe.
- If the `sandbox` check (§4.2) comes back with a restrictive value, adapt injection accordingly — same-origin script access or postMessage may need a different path.
- Confirm the Shadow DOM host mounts correctly inside the blob iframe's own viewport (721×396 pane, per the probe) rather than the outer 800×505 iframe.
- Wire the one confirmed symbol-map entry (`"NSE_CM|NIFTY 50"` → `NIFTY`) and extend for BANKNIFTY.
- Re-run the full P4/P5/P6 test matrix inside the Kotak frame specifically — frame-nested DOM can have subtly different focus/event/z-index behavior than a top-level document.

**R-P7:** identical probe + degradation contract as TradingView (§5.4) — a failed probe here (e.g., blocked by `sandbox`) degrades to manual mode exactly the same way, it doesn't fail differently just because it's a broker platform.

**Est: 1.5 days** (down from 2 — the API-discovery risk that justified the original placeholder is resolved; what's left is frame plumbing, which is concrete and bounded)

### P8 — Hardening
Full §7 checklist, §9 test matrix, and a **full trading-session soak, 9:15–15:30, DevTools open, zero errors, flat memory.** That soak is the real acceptance gate.

**Est: 1.5 days**

**Phase 1 total ≈ 11–13 days.** (Both discovery phases are now complete; the estimate is firm except for whatever the `sandbox` check in §4.2 turns up.)

---

## 7. Reliability standard (applies to every phase)

### 7.1 Never display a number we can't vouch for
Ranked behaviour: **correct > visibly absent > visibly stale > silently wrong.** Every path picks one of the first three.
- `priceToY` → `null` ⇒ hide. Never extrapolate.
- Data > 15s old or `is_fresh === false` ⇒ dim + `stale` + Trade disabled.
- `NaN`/`null`/`undefined` in any price ⇒ that element does not render. No `?? 0`.

### 7.2 No silent failures
`.catch(() => {})` is banned. Every failure surfaces in the UI, logs with context, or trips the degradation path.

### 7.3 Order-path safety
Idempotency key · disable-on-submit · **no auto-retry on POST** · confirm dialog with ₹ risk · slippage guard · ambiguous timeout ⇒ "check positions", never a retry.

### 7.4 Never break the host page
No host CSS modified. No host globals patched except our own SPA-nav hook, which must be restorable. Every bridge call wrapped. **Disabling the extension must leave the page exactly as found.**

### 7.5 Lifecycle correctness
Every listener/observer/rAF/interval released. Survives: SPA nav, symbol switch, timeframe switch, tab background/foreground, service-worker restart, extension reload with charts open, multiple tabs. **Test: switch symbols 50× — listener count and heap flat.**

### 7.6 Performance budget
Widget layer < 0.3 ms/frame. Zero DOM writes when the chart is still. One rAF loop. Measured in the Performance panel.

### 7.7 Degradation ladder
| Failure | Behaviour |
|---|---|
| Our API unreachable | Dimmed last-known + `stale`, Trade disabled, backoff, reconnect banner. **If a position is open: red unprotected warning (R-OCO).** |
| API partial data | Render present fields only; hide the rest individually |
| Bridge probe fails | Manual mode: fixed draggable panel + badge. Values still shown, still tradeable. |
| Chart not ready / torn down | Nothing renders, no throw, retry next frame |
| Price off-screen | Element hidden; returns on scroll-back |
| Symbol unmapped | Widget hidden with a reason in the popup |
| Market closed | `Market closed`, Trade disabled |
| Order rejected | Inline server message; widget stays usable |

### 7.8 Observability
`[TradePilot]` namespaced logger. Logs every state transition, degradation trip, probe result, and order submit/response with its idempotency key. When something goes wrong at 9:20am you need the log, not a repro.

---

## 8. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 8.1 | **Vendor renames internals in a deploy** — inherent to extension-first | **HIGH** | §5.4 probe + degradation + build marker. Bridge quarantined to one folder so the fix is one file. **Accepted risk of the chosen approach.** |
| 8.2 | **Stale price shown as live** → trade on a bad number | **HIGH** | §7.1; `is_fresh`; staleness timer; Trade disabled when unsure |
| 8.3 | **Duplicate order** from double-click/retry | **HIGH** | R-P6: idempotency key, disable-on-submit, no auto-retry. Backend dedupe required. |
| 8.4 | **Position left unprotected** — backend down while open, TP/SL unenforced | **HIGH** | R-OCO: exit monitoring server-side only; unmissable warning; never client-side stops |
| 8.5 | Widget jitter from continuously recomputed levels | MED | Hysteresis (move only if Δ > `max(2 ticks, 0.3×ATR)`); levels update ≤1/s and animate over 300ms while the entry marker rides at frame rate; freeze on interaction |
| 8.6 | Regulatory / vendor policy | *Descoped* | Personal use, own wrapper API, human clicks every order. Revisit only if ever distributed. |
| 8.7 | Kotak `sandbox` iframe attribute blocks injection/messaging | LOW–MED | Awaiting your one-line check (§4.2); if restrictive, worst case = manual mode, still a usable product. Everything else about Kotak reachability is now resolved — the API works (§4.2). |
| 8.8 | Chart feed ≠ our feed → widget sits a tick off the candle | LOW | Display-align to the chart's last price; trade off our feed. Decide in P5. |
| 8.9 | Frame-rate damage to the host chart | MED | R-P4a: transform-only, sub-pixel skip, single loop, measured budget |

---

## 9. Test matrix

| Scenario | Expected |
|---|---|
| Pan / zoom / Y-scale drag | Tracks price exactly, no lag, no jitter |
| Price scrolls off-screen | Hides cleanly; returns on scroll-back |
| Symbol switch | Clean re-anchor, no ghosts, no stale numbers |
| Timeframe switch | Same |
| SPA navigation away and back | Correct unmount/remount |
| Extension reload with charts open | No orphan hosts, no double widgets |
| 3 chart tabs open | 3 independent widgets, no cross-talk |
| Our API stopped mid-session | `stale` + Trade disabled + backoff; recovers on restart |
| API stopped **with a position open** | Red unprotected warning |
| API slow (5s artificial delay) | No flicker, no out-of-order overwrite |
| `sl`/`tp` return `null` | Those pills hide; card still works |
| **Double-click Trade** | **Exactly one order** |
| Trade against a rejecting backend | Inline error; widget usable |
| Bridge probe forced to fail | Manual mode + badge; host page unaffected |
| Browser zoom 80/100/150%, dpr 1/2 | Correct positioning at all |
| Market closed | `Market closed`, Trade disabled |
| Switch symbol 50× | Flat listeners, flat heap |
| Disable extension | Page exactly as found |
| **Full session soak 9:15–15:30** | **Zero console errors, flat memory** |

---

## 10. Open questions

1. **The Kotak `sandbox` attribute check** (§4.2) — the one remaining unknown, a single read-only line. Everything else about Kotak reachability is resolved.
2. **Does `/v1/paper/recommend` produce a suggestion continuously, or only when `trade_recommended === true`?** Your no-strategy model needs levels available **at all times**, not just when a setup fires. If it's gated, we need a flag or an always-on `/levels` endpoint. **Most likely backend work item — I'd check this next.**
3. **Does `POST /manual/order` dedupe by client key today?** If not, that's a required backend change before P6 (R-P6).
4. **Where does the API run?** `http://127.0.0.1:8000` assumes same machine as the browser. If not, we need a host/tunnel and the `host_permissions` change.
5. **Paper or live by default?** I recommend paper, with an explicit visually-distinct live toggle.
6. **Multi-position display** — with several open positions plus a live suggestion, show all widgets or only the suggestion plus the selected position? Affects collision handling in P3.
7. **TradingView symbol coverage** — which symbols do we map? NIFTY/BANKNIFTY only, or wider?
8. **Full symbol map for Kotak** — confirmed so far: `"NSE_CM|NIFTY 50"` → `NIFTY`. Need the equivalent string for BANKNIFTY and any option-chain symbols before P7 wraps.

---

## 11. What happens first

1. **P1 starts immediately** — both discovery phases are done; the skeleton needs nothing further from anyone.
2. **You run the `sandbox`-attribute check** (§4.2) whenever convenient — the one loose end before P7's frame-injection work.
3. **Check Q2 and Q3** in the backend — both may need work, and both gate later phases.

The one thing worth restating: building on vendor internals means a deploy can break the integration — true for both tradingview.com and Kotak now that §4.2 showed they're the same API family. That risk is accepted, and it's handled the only way it can be: a probe that detects breakage immediately and a degradation path that keeps the widget honest and usable when it happens. The bridge is one class with per-host config, so recovery is one file, and a fix for one host's breakage very likely fixes the other's too.
