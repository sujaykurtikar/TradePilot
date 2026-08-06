# Zing Trade — Strategies & Signals (Manual vs Strategy Trading Mode)

**Status:** Planning only. No implementation started.
**Relationship to [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md):** that document (Phase 1 P0–P8) is already built and working in this repo — side panel, on-chart widget, anchoring, drag, capability probe, order/confirm flow. This document is a separate, additive phase (**Phase 3**) on top of it. Kept as its own file rather than appended to the master plan because it's a distinct feature area with its own UI, its own storage schema, and its own rollout — not a revision of what P0–P8 already shipped.

**Do not break:** everything in IMPLEMENTATION_PLAN.md §7 (the reliability standard) and §9 (the test matrix) still applies and must keep passing unchanged. Every storage change below is additive with a migration; nothing here modifies `StorageSchemaV2`/`StorageManager` (the extension enable/disable, widget collapse, widget offsets — untouched) or the existing on-chart drag/anchor mechanics.

---

## 1. What's being built, in one page

Reference screenshots (user-supplied, modeled on the "Zing" app's own side panel) show three tabs — **Signals**, **Strategies**, **Learn Strategies** — replacing today's simpler **Connect broker / Strategy** tab bar, plus a persistent header showing broker connection status instead of a dedicated tab for it.

The functional core, stated directly by the user:

> "We will be having a list of strategies running in the backend. We can add one to Signals — similar to Zing. If the user doesn't add any strategy to Signals, it works in direct normal manual mode — no signal applied, so it works manually."

So **there is no separate manual/strategy toggle switch** (an earlier round of Q&A in this conversation proposed one — superseded by this). The mode is **derived**:

```
0 strategies applied  →  Manual mode   (on-chart widget: user sets entry/TP/SL by hand, no auto-signal)
≥1 strategy applied   →  Strategy mode (on-chart widget: driven by the user-picked "active" applied strategy's signal)
```

```
Phase 3  ── STRATEGIES, SIGNALS & MANUAL MODE ───────────────────────────
  P9   Storage & mock data     richer Strategy model, appliedStrategyIds,
                                activeStrategyId, mock 16-strategy dataset
  P10  Side panel shell        persistent header (broker status folded in),
                                Signals / Strategies / Learn Strategies tabs
  P11  Strategies tab UI       login gate, instrument filter, strategy cards,
                                Apply / Remove, favorite, alerts
  P12  Signals tab UI          login gate, filter chips, filter drawer,
                                empty state, per-strategy signal cards,
                                "set active" control for multi-apply
  P13  Bootstrap wiring        derive trading mode, branch suggestion vs.
                                manual-levels path, manual drag-to-set TP/SL,
                                manual Trade submit (reuses existing confirm/
                                idempotency machinery, doesn't duplicate it)
  P14  Hardening               regression pass on §7/§9, migration safety,
                                "Learn Strategies" stub, soak test
                                                          ≈ 7–9 days total
```

---

## 2. Decisions already made (this conversation)

| # | Decision | Why |
|---|---|---|
| 1 | Mode switch lives only in the side panel; the on-chart widget has no separate mode control | Matches the reference — the chart just reflects whatever the side panel's Signals list currently says |
| 2 | Manual mode reuses the **same** on-chart TP/SL/Suggested widget — no separate "manual panel" | Least disruption to P3/P4's existing anchoring/drag code; user sets entry/TP/SL by dragging, same mechanics as today |
| 3 | Strategy mode keeps today's fully-draggable TP/SL behavior unchanged | No regression to the existing P6t trail behavior |
| 4 | **Mode is derived from "is any strategy applied," not a manual toggle** | Directly stated by the user, supersedes decision context implied by #1 |
| 5 | Broker connection status folds into a persistent header (matches reference); "Connect broker" is no longer its own tab | User's explicit answer, matches the reference screenshots exactly |
| 6 | Strategy performance data (win rate, daily history, today's returns) is **mocked/local for now**, same honest-demo pattern as `demoSuggestion.ts` | No real backend for this exists yet (confirmed by exploring the current `Strategy` model — it's just `{name, notes}`); mocking now with a documented seam avoids blocking the UI build on backend work |
| 7 | If multiple strategies are applied, the user explicitly picks which one is "active on chart" | User's explicit answer — most control, avoids an arbitrary "first applied wins" rule |

---

## 3. Current state (what already exists — verified by reading the code, not assumed)

- **Side panel**: `sidepanel/sidepanel.html` + `sidepanel/sidepanel.ts`, built separately from the content-script bundle (`dist/sidepanel.js`). Two tabs today: `#tab-brokers` / `#tab-strategy`, toggled by `switchTab()` — local UI state only, not persisted.
- **"Strategy" tab today**: a minimal CRUD form — `name` + `notes` textarea → `Strategy { id, name, notes, createdAt }`, saved via `SidePanelStorageManager`. Explicitly labeled in the HTML as "more automation here soon." No win rate, no returns, no apply/remove, no linkage to the chart widget at all.
- **Broker list today**: hardcoded array in `sidepanel.ts` (Lemonn, CoinSwitch, Dhan, 915 by Groww, Zerodha Kite, Angel One, Upstox). "Open" opens a modal collecting API key/secret, saved straight to `chrome.storage.local` — no real OAuth, no validation, no wiring to `OrderService.ts` (which is hardcoded `paperMode: true`). "Connected" today just means a key/secret pair exists in storage.
- **On-chart suggestion today**: `src/widget/WidgetRoot.ts` takes one `WidgetSuggestionData` object; `src/content/Bootstrap.ts` builds it from either `buildDemoSuggestionConfig()` at initial mount or `snapshot.suggestion` from `DataPoller` once real polling data arrives (`applyMarketData()`). **There is no existing "manual, user-picks-own-entry" code path anywhere** — every path today assumes a `Suggestion` object drives the numbers.
- **Storage**: two separate `chrome.storage.local` blobs — `src/core/storage/schema.ts` (`StorageSchemaV2`, key `tradepilot_state`: `enabled`, `widgetCollapsed`, `widgetOffsets`, `widgetHiddenReason` — has a working versioned-migration scaffold) and `src/core/storage/sidePanelSchema.ts` (`SidePanelSchema` v1, key `tradepilot_sidepanel`: `brokers`, `strategies`). **Neither has a trading-mode field.** `Bootstrap.ts` only reads/subscribes to the first one today — it has no wiring to the sidepanel's storage at all.
- **`WidgetMode = 'anchored' | 'manual'`** (`WidgetRoot.ts`) is an unrelated, pre-existing concept — it's the capability-probe degradation mode (can the widget track live chart coordinates or not), nothing to do with trading mode. **Naming collision risk** — see §6 naming note below.

---

## 4. UI structure (from the reference screenshots)

### 4.1 Persistent header (new — replaces the current plain header)
- Broker avatar + name + "Connected" state (e.g. "D · Dhan Connected"), with the existing enable/disable toggle switch moved here from wherever it lives today.
- Info icon (ⓘ) — existing "API status/version" info, relocated.
- Settings icon (⚙, with a notification dot) — new: entry point for account/strategy settings; scope of what's actually inside it is **not specified by the screenshots** and needs a follow-up decision before P10 (flagged in §8).

### 4.2 Tab bar: **Signals | Strategies | Learn Strategies**

### 4.3 Strategies tab
- If not authenticated against the (future) strategies backend: amber-bordered gate card — "Login to start using Zing Strategies" + a Login button. (Distinct from broker login — see §8 open question on what this auth actually is for now.)
- "All strategies (N)" label + an instrument filter dropdown (e.g. "NIFTY ⇅").
- Strategy card, repeated per strategy:
  - Icon avatar, name (e.g. "SwingKing Sniper", "Traffic Light"), instrument tag (e.g. "NIFTY"), win rate (e.g. "Win rate 17%").
  - Bell icon (alerts toggle), star icon (favorite).
  - "Last week" — 5 day-circles (Mon–Fri), colored per win/loss that day.
  - "Today's Returns" — a signed percentage, colored (red for negative in the reference).
  - **Apply** button (white pill) if not applied; **Remove** (outlined pill) if applied — applied cards get a highlighted (amber) border.

### 4.4 Signals tab
- Same login-gate card as Strategies (shared component) until authenticated.
- Filter row: a filter/funnel icon (opens the filter drawer, §4.5) + count chips: "All Signals (N)", "Recommended (N)", "Win rate ≥ 50% (N)" (more chips scroll off-screen in the reference — exact full list TBD, not fully visible in the screenshot).
- Empty state: centered illustration (lightbulb-in-a-box) when no strategies are applied — this **is** the plain manual-mode state per §2's core decision; copy text isn't legible in the reference and needs to be written (e.g. "No signals yet — apply a strategy to see live signals here, or trade manually on the chart").
- When ≥1 strategy is applied: one signal-card entry per applied strategy (visual language TBD — likely close to the strategy card's own layout, showing the live recommended trade from that strategy). If more than one is applied, whichever the user has marked **active** (§2 decision #7) is the one mirrored onto the chart widget; the control for marking a strategy active lives here (exact affordance — a radio/checkmark per card, most likely — is a P12 detail, not fully specified by the screenshot).

### 4.5 Filter drawer (opens from the Signals tab's filter icon)
- Left rail: category icons — "Win rate", "Call/Put", "Strategies" (an instrument category, e.g. "All Indices", is shown selected in the reference).
- Right pane: content for the selected category — e.g. "All Indices" shows a checkbox list (NIFTY 50, SENSEX).
- "Clear all" link (top-right), **Cancel** / **Apply** buttons (bottom).

### 4.6 "Learn Strategies" tab
Not shown in any reference screenshot. Scope unknown — flagged as an open question in §8; planned as a simple static content stub for P14 unless the user specifies otherwise.

---

## 5. Data model & storage changes

All additive, versioned, migrated — no existing field removed or reinterpreted.

### 5.1 `sidePanelSchema.ts` → v2

```ts
export interface StrategyV2 {
  readonly id: string;
  readonly name: string;
  readonly notes: string;           // kept — existing field, unchanged meaning
  readonly createdAt: number;
  // New fields, mocked for now (§2 decision #6):
  readonly instrument: string;              // e.g. 'NIFTY' | 'SENSEX'
  readonly winRatePct: number;              // 0–100
  readonly lastWeekDaily: readonly ('win' | 'loss')[]; // Mon–Fri, length 5
  readonly todayReturnsPct: number;         // signed
  readonly favorite: boolean;
  readonly alertsEnabled: boolean;
}

export interface SidePanelSchemaV2 {
  readonly version: 2;
  readonly brokers: Readonly<Record<string, BrokerConnection>>; // unchanged shape
  readonly strategies: readonly StrategyV2[];
  readonly appliedStrategyIds: readonly string[];   // order = application order
  readonly activeStrategyId: string | null;         // §2 decision #7 — which applied strategy drives the chart
  readonly strategiesLoggedIn: boolean;             // stub auth flag until a real backend exists
}
```

Migration `v1 → v2`: existing `strategies` (bare `{name, notes}`) get default-filled new fields (`instrument: 'NIFTY'`, `winRatePct: 0`, `lastWeekDaily: []`, `todayReturnsPct: 0`, `favorite: false`, `alertsEnabled: false`) so nothing crashes on upgrade; `appliedStrategyIds: []`, `activeStrategyId: null`, `strategiesLoggedIn: false` by default — **this preserves today's actual behavior**: zero strategies applied on upgrade means every existing install lands in manual mode until the user explicitly applies one, which is a real, visible behavior change worth calling out to the user before shipping (§8 open question — today's behavior is "always strategy-suggestion-driven"; post-launch default becomes "manual until you apply something").

### 5.2 Mock strategy dataset
A local, clearly-commented mock list of ~16 strategies (matching the reference's "All strategies (16)") ships in code (similar spirit to `demoSuggestion.ts`) — not user-editable, seeded once, replaced wholesale once a real backend/API for strategy performance exists. The seam: one function, `fetchStrategyCatalog(): Strategy[]`, swappable for a real API call later without touching the UI layer.

### 5.3 Cross-context wiring (new)
`Bootstrap.ts` (content script) currently only subscribes to `StorageManager` (`tradepilot_state`). It needs a **new, additive** subscription to `SidePanelStorageManager`'s `tradepilot_sidepanel` key (via the same `chrome.storage.onChanged` pattern already proven in `StorageManager.onChange`) to react when the side panel's applied/active strategy changes — this is new wiring, not a modification of the existing enable/collapse/offsets flow.

---

## 6. On-chart widget changes (`Bootstrap.ts` / `WidgetRoot.ts`)

**Naming**: introduce `TradingMode = 'strategy' | 'manual'` as an explicit new type, deliberately **not** reusing `WidgetMode`/`DegradationMode` (`'anchored' | 'manual'`) — that existing type is about chart-coordinate degradation, unrelated, and already uses the string `'manual'` for something else. Comments in both places should cross-reference the other to prevent future confusion between the two.

**Derivation**: `tradingMode = appliedStrategyIds.length > 0 ? 'strategy' : 'manual'` (read from the new sidepanel storage subscription, §5.3).

**Strategy mode** (`tradingMode === 'strategy'`): unchanged from today — `applyMarketData()` keeps building `WidgetSuggestionData` from `snapshot.suggestion` exactly as it does now, with one addition: which strategy is "active" (§2 decision #7) is passed through as context/label only for now (e.g. which strategy name shows on the Suggested card) — the actual `/recommend` signal computation is unaffected, since **there is no per-strategy backend signal yet** (see open question in §8, item 1).

**Manual mode** (`tradingMode === 'manual'`): a new path in `Bootstrap.ts` —
- New local state `manualLevels: { tp: number | null; sl: number | null }`, initialized `null`/`null` (or defaulted a small offset from live price, TBD).
- `WidgetSuggestionData.tp`/`.sl` come from `manualLevels` instead of `snapshot.suggestion`; `livePrice()` stays wired to `bridge.lastBar()?.close` exactly as today.
- Per the earlier decision in this conversation, the pills are draggable exactly like today (reusing `DragManager`/`AnchorManager` unchanged) — a drag in manual mode updates `manualLevels` directly (new `onDragEnd` branch) instead of calling `handlePositionRiskDrag` (which is position-specific, post-trade only, and stays untouched).
- `onTrade`/`handleTradeClick`/`handleConfirmClick`/`PlaceOrderRequest` submission path is **reused as-is** — manual mode only changes where `tp`/`sl`/`direction`/`strike` come from before that pipeline runs (from `manualLevels` + user-set direction/strike instead of `snapshot.suggestion`), not the pipeline itself (idempotency key, disable-on-submit, confirm dialog, slippage guard all keep applying — §3/§7.3 of the master plan are not being weakened for manual mode).
- **New UI needed that doesn't exist yet**: manual mode has no `Suggestion.direction`/`recommendedOptionType`/`recommendedSymbol` to show on the card — some minimal manual-entry affordance (pick CE/PE, pick strike) is required before Trade is clickable. Not specified by any reference screenshot; flagged as an open question in §8.

---

## 7. Reliability requirements for this phase (extends master plan §7)

- **R-P9 (storage safety)**: a corrupt/missing sidepanel-storage read must fall back to `appliedStrategyIds: []`/`activeStrategyId: null` (i.e., manual mode), never crash the widget or silently keep showing a stale strategy suggestion.
- **R-P13 (mode-switch correctness)**: switching `tradingMode` live (user applies/removes a strategy while a chart tab is open) must cleanly swap the suggestion source next frame — no stale numbers from the previous mode lingering, matching the existing "never display a number we can't vouch for" standard (§7.1 of the master plan).
- **R-P13 (in-flight trade guard)**: if the user is mid-confirm (`isFrozen`, per existing `handleTradeFocusChange`) and the trading mode changes underneath them (e.g. a second browser context toggles applied strategies), the frozen confirm context must not be silently swapped — cancel the confirm and show why, rather than submitting a trade built from mixed manual/strategy data.
- **No regression**: every row of the master plan's §9 test matrix must still pass with zero strategies ever applied (today's closest equivalent state) and with the existing broker-connect flow, whichever tab/header shape it ends up in.

---

## 8. Open questions (need a decision before or during implementation — not guessed at here)

1. **Per-strategy backend signal**: today's `/recommend` endpoint produces one suggestion, full stop — there's no concept of "this strategy's signal" vs. "that strategy's signal." Does applying "SwingKing Sniper" vs. "Traffic Light" actually change what number the chart shows, or — until a real backend exists — do all applied strategies show the same underlying `/recommend` suggestion, just labeled differently? This gates how real P12/P13 can be for now vs. how much stays mocked.
2. **Settings gear icon** (§4.1): what lives behind it? Not shown in any screenshot.
3. **"Learn Strategies" tab** (§4.6): content/purpose unspecified.
4. **Manual-mode trade entry**: what does the user actually pick before a manual Trade is valid — index + CE/PE + strike, or something simpler? (§6, last bullet)
5. **Strategies-backend login** (§4.3/§4.4 gate card): is this meant to represent a real upcoming auth system, or should it just be treated as always-authenticated for now (skip the gate) since there's no backend yet to log into?
6. **Migration behavior change** (§5.1): confirming it's acceptable that upgrading existing installs puts everyone into manual mode by default (zero strategies applied) until they explicitly apply one — today's behavior is "always strategy-suggestion-driven, no concept of applying anything."
7. **Filter chip full list** (§4.4): only 3 of what looks like more chips are visible in the reference screenshot (cut off at the right edge) — full set TBD.

---

## 9. Phased build order

| Phase | Scope | Depends on |
|---|---|---|
| P9 | Storage v2 + migration + mock strategy dataset | none |
| P10 | Side panel shell: persistent header, 3-tab bar (structural only, no content yet) | P9 |
| P11 | Strategies tab: cards, apply/remove, favorite/alerts, instrument filter | P9, P10 |
| P12 | Signals tab: filter chips + drawer, empty state, per-strategy signal cards, active-strategy picker | P9, P10, P11 (needs Apply to exist first) |
| P13 | Bootstrap wiring: derive `TradingMode`, manual-levels path, manual drag-to-set, manual Trade submit reusing existing pipeline | P9, P12 |
| P14 | Hardening: regression pass on master plan §7/§9, migration-safety test (upgrade with existing strategies data), Learn Strategies stub, full soak | P9–P13 |

**Estimate: ≈ 7–9 days**, assuming open questions 1, 4, and 5 above are resolved before P12/P13 start (they materially change how real those two phases can be built vs. how much stays mocked).

---

## 10. What happens first

1. Resolve open questions 1, 4, 5, 6 above — they change the shape of P12/P13, not just cosmetic detail.
2. P9 (storage + mock data) can start immediately regardless — it's additive and doesn't depend on any open question.
3. P10 (side panel shell) can start immediately after P9 — pure structural UI change, low risk.
