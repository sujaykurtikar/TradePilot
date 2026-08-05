# TradePilot — Chrome Extension Implementation Plan

**Status:** Planning only. No implementation started.
**Date:** 2026-08-05
**Decision:** **Chrome extension is Phase 1.** Targets: **Kotak Neo (priority)** and **TradingView.com**. The in-app overlay on `quantboard-pandapath` is deferred to Phase 2 — it is *not* part of the first delivery.

**Goal:** A Zing-style on-chart widget — TP pill above, `Suggested / <strike> / [Trade]` card riding the live price, SL pill below — injected onto charts we don't own, with one-click execution through our own wrapper API.

**Overriding requirement: RELIABILITY.** Every phase carries an explicit *Reliability Requirements* block. §7 defines the standard they are measured against. Nothing merges without meeting it.

**Noted once, not treated as a blocker:** I recommended building on our own chart first because vendor internals can break without warning (§8.1). That recommendation was considered and overruled — extension first. The plan below therefore invests heavily in the **capability probe + degradation ladder** (§5.4, R-P2), which is how we make an inherently fragile integration behave predictably. SEBI/vendor-policy constraints are descoped per your decision (personal use, own wrapper API) — recorded once in §8.6.

---

## 1. The plan in one page

```
Phase 1  ── CHROME EXTENSION ────────────────────────────────────────────
  P0  Discovery      TradingView ✅ already verified  ·  Kotak ⏳ needs probe
  P1  Skeleton       MV3 + Vite + TS strict, Shadow DOM, messaging, popup
  P2  ChartBridge    interface + TradingViewSiteBridge (verified working)
  P3  Widget UI      TP pill / Suggested card / SL pill — matches the design
  P4  Anchoring      widget tracks live price + levels through the bridge
  P5  Data           service worker → our FastAPI → suggestion + levels
  P6  Trade          entry order via our wrapper; TP/SL enforced by our engine
  P7  Kotak adapter  KotakNeoBridge (unblocks when the probe lands)
  P8  Hardening      §7 checklist + full-session soak
                                                          ≈ 12–14 days

Phase 2  ── IN-APP OVERLAY (deferred) ───────────────────────────────────
  Port the same widget into quantboard-pandapath's LiveOI chart.
  ~3 days, because P3/P4/P5/P6 are already built and reusable.
```

**Key sequencing decision:** build against **TradingView first**, even though Kotak is the priority target. Reason — I have already verified TradingView's chart API works end to end (§4.1), and it needs **no login**, so P1–P6 can start today and run at full speed. The Kotak adapter (P7) is a self-contained ~2-day slot that drops in the moment the probe output arrives. **Nothing is blocked waiting on Kotak.**

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

### 4.2 Kotak Neo — BLOCKED, needs your 60-second probe

Kotak Neo's web platform uses **TradingView Advanced Charts** — the licensed library, fed by Kotak's own datafeed. That is *better* than tradingview.com: Advanced Charts has a **documented public API**, and the widget is conventionally exposed as `window.tvWidget`.

I could not verify it. Brokerage sites are blocked by browsing policy in both available browsers — not overridable, and a sensible guardrail on a live-money account.

**Four questions gate P7. None can be answered from outside:**

1. Is the chart inside an **iframe**? (→ `all_frames: true` + cross-frame messaging, or a dead end)
2. Which global holds the widget? (`window.tvWidget`, something else, or nothing reachable)
3. Does `priceToCoordinate` work there?
4. What is the pane geometry / DOM shape around the chart?

**Run this in the Console on a Kotak NIFTY chart (F12 → Console). Read-only — it reads properties and calls a pure coordinate function. It places nothing and clicks nothing. Result lands on your clipboard.**

```bash
copy(JSON.stringify((()=>{const o={url:location.href};o.iframes=[...document.querySelectorAll('iframe')].map(f=>({src:(f.src||'').slice(0,100),w:f.clientWidth,h:f.clientHeight}));o.canvases=[...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height,p:(c.parentElement?.className||'').toString().slice(0,50)}));const g=[];for(const k of Object.keys(window)){try{const v=window[k];if(v&&typeof v==='object'&&typeof v.activeChart==='function')g.push(k)}catch(e){}}o.widgetGlobals=g;o.tvWidget=typeof window.tvWidget;o.TradingView=typeof window.TradingView;const w=window.tvWidget||(g[0]?window[g[0]]:null);if(w){try{const c=w.activeChart();o.symbol=c.symbol();o.resolution=c.resolution();const ps=c.chartWidget().paneWidgets()[0].state().defaultPriceScale();o.priceToCoordinate=ps.priceToCoordinate(24000);o.coordinateToPrice=ps.coordinateToPrice(100);o.paneRect=c.chartWidget().paneWidgets()[0].canvasElement().getBoundingClientRect().toJSON()}catch(e){o.probeErr=e.message}}return o})(),null,1))
```

If `iframes` shows the chart is inside one, switch the Console's frame dropdown (labelled `top`) to the chart frame and re-run.

**P7 cannot be estimated beyond its ~2-day placeholder until this output exists.** Everything else proceeds regardless.

---

## 5. Architecture

### 5.1 Execution contexts

```
┌─ MAIN world content script ── bridge.js ──────────────────────┐
│  The ONLY code that touches host-page chart internals.        │
│  TradingViewSiteBridge · KotakNeoBridge                        │
│  Small, defensive, disposable. Fix here when a vendor deploys. │
└──────────────── window.postMessage (nonced) ──────────────────┘
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
```

Three implementations, one widget. Phase 2's `LightweightChartsBridge` is ~20 lines over the documented API — which is why the in-app port later costs ~3 days, not 12.

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
│   │   ├── mainWorld.ts            # MAIN-world entry; selects an adapter
│   │   ├── ChartBridge.ts          # the interface
│   │   ├── adapters/
│   │   │   ├── TradingViewSiteBridge.ts
│   │   │   └── KotakNeoBridge.ts
│   │   ├── CapabilityProbe.ts
│   │   └── protocol.ts             # nonced postMessage envelope
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
TradingView ✅ complete (§4.1). Kotak ⏳ awaiting your probe output (§4.2).
**Est: 0.5 day** (Kotak analysis once output lands)

### P1 — Extension skeleton
MV3 manifest (`minimum_chrome_version: 111`), Vite + TypeScript strict, two build configs (content scripts must be **IIFE** — MV3 content scripts don't support ESM; the service worker is `type: module`). Shadow DOM host. Typed message bus. Storage with schema + migrations scaffold. Popup: enable / disable / reset position / API status / version. ESLint flat config + Prettier + `import/no-restricted-paths` enforcing the bridge quarantine.

Manifest essentials:
```jsonc
"permissions":      ["storage", "scripting", "activeTab"],
"host_permissions": ["https://*.tradingview.com/*",
                     "https://*.kotaksecurities.com/*",
                     "http://127.0.0.1:8000/*"],       // our FastAPI
"content_scripts":  [ { world: "ISOLATED", js: ["content.js"] },
                      { world: "MAIN",     js: ["bridge.js"]  } ]
```

**R-P1**
- Single-injection guard: a `window` flag **and** a DOM-id check — they fail in different situations (SPA nav vs. service-worker restart vs. multiple tabs).
- SPA navigation: patch `pushState`/`replaceState`, listen to `popstate`, plus a `MutationObserver` backstop. Both targets are SPAs.
- Full teardown on disable/navigate: remove host, disconnect every observer, release every listener. **Verified by toggling 20× and watching listener count and heap stay flat.**
- `all_frames: false` by default; flipped only if the Kotak probe shows an iframe.

**Est: 2 days**

### P2 — ChartBridge + TradingViewSiteBridge + probe
The interface, the MAIN-world entry, the TradingView adapter over the verified calls in §4.1, the capability probe, the nonced postMessage protocol (namespace + per-session nonce; verify `event.source === window` and `event.origin === location.origin` — a page script can post into the isolated world).

**R-P2** as specified in §5.4, in full. **This ships before anything depends on the bridge, not after.**

**Est: 2 days**

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

### P7 — Kotak Neo adapter
`KotakNeoBridge` over the probe's findings. If iframed: `all_frames: true` + frame-targeted injection + cross-frame messaging. Kotak symbol mapping. Re-run the full P4/P5/P6 test matrix on Kotak.

**R-P7:** identical probe + degradation contract as TradingView. Kotak-specific: if their chart is Advanced Charts with a documented API, prefer the public methods over internals wherever both exist — public API is far more stable.

**Est: 2 days** *(placeholder — firm only after the probe output)*

### P8 — Hardening
Full §7 checklist, §9 test matrix, and a **full trading-session soak, 9:15–15:30, DevTools open, zero errors, flat memory.** That soak is the real acceptance gate.

**Est: 1.5 days**

**Phase 1 total ≈ 12–14 days** (P7 firm only after the probe).

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
| 8.7 | Kotak chart unreachable (iframe / no global) | MED | Probe answers it; worst case = manual mode, which is still a usable product |
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

1. **The Kotak probe output** (§4.2) — the one thing blocking P7. Everything else proceeds without it.
2. **Does `/v1/paper/recommend` produce a suggestion continuously, or only when `trade_recommended === true`?** Your no-strategy model needs levels available **at all times**, not just when a setup fires. If it's gated, we need a flag or an always-on `/levels` endpoint. **Most likely backend work item — I'd check this next.**
3. **Does `POST /manual/order` dedupe by client key today?** If not, that's a required backend change before P6 (R-P6).
4. **Where does the API run?** `http://127.0.0.1:8000` assumes same machine as the browser. If not, we need a host/tunnel and the `host_permissions` change.
5. **Paper or live by default?** I recommend paper, with an explicit visually-distinct live toggle.
6. **Multi-position display** — with several open positions plus a live suggestion, show all widgets or only the suggestion plus the selected position? Affects collision handling in P3.
7. **TradingView symbol coverage** — which symbols do we map? NIFTY/BANKNIFTY only, or wider?

---

## 11. What happens first

1. **P1 starts immediately** — the skeleton needs nothing from anyone.
2. **You run the Kotak probe** (§4.2) whenever convenient; P7 unblocks when it lands.
3. **Check Q2 and Q3** in the backend — both may need work, and both gate later phases.

The one thing worth restating: building on vendor internals means a deploy can break the integration. That risk is accepted and the plan handles it the only way it can be handled — a probe that detects breakage immediately and a degradation path that keeps the widget honest and usable when it happens. The bridge is one folder, so recovery is one file.
