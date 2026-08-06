# TradePilot Backend Integration — Connecting Real Strategies to the Extension

**Status:** Planning only. No implementation started.
**New backend repo:** [github.com/sujaykurtikar/TradePilotBackend](https://github.com/sujaykurtikar/TradePilotBackend) — created by the user, this is where §6's build phases land.
**Relationship to other plan docs:**
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (Phase 1, P0–P8) — already built. Describes the extension calling "our FastAPI" directly at `127.0.0.1:8000`; this doc **supersedes that assumption** — the extension will call a **new, separate, fully isolated backend project** instead (see §3).
- [IMPLEMENTATION_PLAN_STRATEGIES_SIGNALS.md](IMPLEMENTATION_PLAN_STRATEGIES_SIGNALS.md) (Phase 3, P9–P14) — the Signals/Strategies side-panel UI plan. Its §5.2 said strategy performance data would be **mocked for now, with a documented seam to swap in a real backend later**. This document **is** that real backend.

**IMPORTANT — superseded architecture, kept below (§3 original) for history only:** an earlier revision of this plan had the new backend proxy `quantboard-pandapath`'s existing `/v1/paper/strategies*` endpoints at runtime. **The user has since decided this must be fully isolated instead** — no runtime dependency on `quantboard-pandapath` at all (no HTTP calls to it, no shared database, no import of its code). §1 below (what exists in quantboard-pandapath) stays relevant only as a **reference/porting source** — its strategy *logic* gets read and reimplemented as independent code inside the new repo, one time, not called live. See §3 for the current, correct architecture.

---

## 1. What already exists in `quantboard-pandapath` (verified by reading the code)

A thorough review of `C:\Users\sujay\CKProjects\quantboard-pandapath` turned up more than expected — the hard part of this feature is already real and working there:

- **A genuine pluggable multi-strategy registry**, not just one fixed suggestion engine: `services/paper_trading/strategies/` defines a `BaseStrategy`/`StrategySignal` contract (`base.py:16-93`) and a module-level registry (`strategies/__init__.py:36-97`) with `list_strategies()`, `get_strategy(id)`, `evaluate_all()`, `evaluate_one(id)`.
- **7 real, working named strategies**: `confluence_core`, `orb_option_buy`, `oi_pcr_directional`, `iv_aware_momentum`, `max_pain_magnet`, `expiry_pin_fade`, `orb_flow_scalp` — each its own file, each producing a real `StrategySignal` (direction, strike, option_type, sl, tp, confidence, rationale). Plus 3 disabled placeholders (`emi_strategy`, `rse_strategy`, `vvab_strategy` — `unverified.py`) and the AI decision-engine wrapped as a synthetic strategy id `ai_recommendation` (`strategy_trader.py:40-56`).
- **Existing HTTP endpoints** (all under `/v1/paper/`, in `apps/api/routes/paper.py`):
  - `GET /v1/paper/strategies` (line 347) — list of strategy metadata.
  - `GET /v1/paper/strategies/evaluate?strategy=<id>` (line 354) — one strategy's current signal, on demand. **This is the exact building block for "per-strategy signal" your Signals tab needs.**
  - `GET /v1/paper/strategies/performance?account=manual` (line 366) — all-time win rate/expectancy/profit-factor **per strategy**, computed by `pnl_engine.day_stats()` over closed `paper_positions`.
  - `POST /v1/paper/chart/strategy/enabled` (line 504) — `{strategy_id, enabled}`, persisted to an `app_settings` KV row — the closest existing analog to "Apply."
  - `GET /v1/paper/recommend` (line 238) — **does not** take a strategy selector; it's a single, fixed AI-only computation, entirely separate from the strategy registry above.
- **No per-day performance breakdown** exists yet — only an all-time aggregate. Raw data to build one exists (`paper_positions` rows carry `ts_open`, `ts_close`, and a `strategy` tag), it's just not bucketed by day anywhere today.
- **No authentication of any kind** — no user table, no login route, no session/JWT, wide-open CORS. It's architected as a single local operator's terminal.
- **No deployment beyond localhost** — no Docker, no cloud config; `start.sh` runs `uvicorn ... --port 8000` directly. A Postgres `DATABASE_URL` sits unused in `.env`; the real store is a local SQLite file (`data/quantboard.db`).
- The backend's own design doc, `STRATEGY_IMPLEMENTATION_PLAN_V1.md`, independently arrived at the same "named strategies with win-rate attribution" concept you're building the UI for — worth reading directly if you want more depth on any one strategy's logic.

---

## 2. Decisions made (this conversation)

| # | Decision | Why |
|---|---|---|
| 1 | **No new auth system for v1.** Extension calls the backend unauthenticated; "which strategies are applied" is stored client-side in the extension's own `chrome.storage` (already the plan in Phase 3 §5.3), not server-side per-user. | quantboard-pandapath has no user concept to hook into, and building one just for this would be disproportionate scope right now. Revisit if this ever needs to work across multiple devices/people. |
| 2 | **Local-only for now; real deployment is an explicit later phase.** | Confirmed — test end-to-end on one machine first, deploy once it works. |
| 3 | **Per-day performance aggregation ("today's returns," daily win/loss strip) will be built**, not deferred. | Confirmed — needed for the strategy cards to show real numbers, not just an all-time stat. |
| 4 | **A new, separate backend project** — not additions inside `quantboard-pandapath` itself. | Confirmed — keeps this independently deployable/versioned, and avoids modifying a codebase you didn't build this session. |

---

## 3. Architecture — fully isolated (current, correct version)

**Decision (this conversation, supersedes the original §3 proxy design):** the new backend has **zero runtime dependency** on `quantboard-pandapath` — no HTTP calls to it, no shared database, no shared process, deployable to a completely different environment with no reference to that repo at all.

To still get the value of quantboard-pandapath's real, working strategy logic (§1) without a runtime dependency, the plan is **port, don't call**: read each strategy's algorithm in `quantboard-pandapath` once, and re-implement it as independent code inside the new repo. It's the user's own code either way (both repos are theirs), so this is a one-time reference/copy, not a licensing concern — just an engineering choice to decouple the two projects completely.

```
Chrome extension (side panel + content script)
        │  HTTP, localhost for now
        ▼
┌───────────────────────────────────────────────────────────────┐
│  "TradePilot Backend"  (own repo: TradePilotBackend, own FastAPI)│
│  Port 8100 (proposed)                                            │
│  - Strategy catalog — OWN code, ported from quantboard-pandapath  │
│    at build time, not called at runtime                          │
│  - Per-strategy signal generation — OWN implementation            │
│  - Own local persistence (SQLite) — logs every signal it ever     │
│    generates; daily/all-time performance is computed FROM THIS    │
│    OWN history, not from quantboard-pandapath's data anywhere     │
│  - Market-data adapter layer (spot/option-chain/OI) — INTERFACE   │
│    defined now, real implementation wired once the user provides  │
│    broker/data-vendor API keys (later phase, see §7)              │
│  - No auth, no order placement (see below)                        │
└───────────────────────────────────────────────────────────────┘
        No arrow to quantboard-pandapath — intentionally none.
```

**Consequence of isolation — performance history starts empty.** Since this backend no longer reads quantboard-pandapath's years of `paper_positions` history, "today's returns" and the daily win/loss strip will have **no real data until the new backend has actually been running and generating signals for a while**. Per this project's established standard (master plan §7.1 — never display a number you can't vouch for), an empty history must show as an honest "not enough history yet" state, never a fabricated or borrowed number. This is a direct, known trade-off of choosing isolation over proxying — worth naming plainly rather than glossing over.

**Order placement is explicitly out of scope for this backend, for now (decided).** No real order/position-risk endpoints are being built here. If a placeholder is useful for the extension's dev/testing loop, a single dummy `POST /orders` that validates its payload shape and always returns a fixed "accepted (stub)" response is fine — it must never be mistaken for a real order path (label it clearly, e.g. `stub: true` in the response) so it can't silently leak into a real-money flow later. **When order placement does come back into scope, the plan is a direct broker API integration (e.g. the official DhanHQ v2 API, confirmed to exist and be free/documented at docs.dhanhq.co) — not UI automation against a broker's website**, which was investigated and rejected as materially riskier (silent wrong-click failures on a money-moving action, likely retail-ToS conflict) — see the chat discussion this plan doc doesn't otherwise repeat.

---

## 4. New backend API surface (design, not final code)

| Endpoint | Behavior |
|---|---|
| `GET /health` | Own status only now (no upstream to report on, by design — isolation means there's nothing else to be honest about here). |
| `GET /strategies/catalog` | Own strategy list — ported strategies, reshaped for the extension's card UI (id, name, description, kind, enabled/status). Does **not** invent an "instrument" field — see open question 1 below. |
| `GET /strategies/{id}/signal?symbol=NIFTY` | Runs that one ported strategy's own logic against whatever market data is currently wired up (mock now, real once API keys land — §7) and returns its `StrategySignal`-shaped output. |
| `GET /strategies/{id}/performance` | All-time win rate/expectancy computed from **this backend's own** signal/paper-outcome history — starts at "no history yet," fills in as it actually runs. |
| `GET /strategies/{id}/performance/daily?days=7` | Same own-history source, bucketed by calendar day. |

Every response wrapped consistently (`{data, error}` shape or similar) so the extension's fetch layer has one honest way to detect "not enough data yet" vs. "real zero" — mirrors the master plan's §7.1 "never display a number you can't vouch for."

---

## 5. What does NOT change

- `quantboard-pandapath` is not touched, called, or referenced at runtime at all — full isolation, no exception this time (§3's earlier "one minimal endpoint" idea from the proxy design is moot now).
- The extension's Phase 3 plan (`IMPLEMENTATION_PLAN_STRATEGIES_SIGNALS.md`) structure is unchanged — this doc only replaces *where the real data comes from* once P9–P11 are built; P12/P13's job becomes "call this new backend" instead of "call the mock `fetchStrategyCatalog()`."
- Order placement, position risk-drag, and the existing confirm/idempotency pipeline in the extension (master plan §6/P6/P6t) are unaffected — they still target quantboard-pandapath directly, or a future Dhan integration, per §3 above.

---

## 6. Phased build order

| Phase | Scope | Depends on |
|---|---|---|
| B1 | Scaffold the new backend project: FastAPI app, project structure, own local SQLite, `/health` | none |
| B2 | Port strategy logic from `quantboard-pandapath`'s `services/paper_trading/strategies/` into this repo as independent modules (start with the 7 real ones: `confluence_core`, `orb_option_buy`, `oi_pcr_directional`, `iv_aware_momentum`, `max_pain_magnet`, `expiry_pin_fade`, `orb_flow_scalp`); define the market-data adapter interface each strategy needs (spot price, option chain, OI — only where a given strategy actually uses it, per the user's "if not needed don't consider" instruction) with a clearly-labeled mock implementation for now | B1 |
| B3 | `GET /strategies/catalog` and `GET /strategies/{id}/signal` wired to the ported strategies (mock data under the hood until real API keys land) | B2 |
| B4 | Own signal/outcome history logging (SQLite) + `GET /strategies/{id}/performance` and `/performance/daily` computed from it — expected to report "not enough history yet" immediately after launch, and fill in over time | B1, B3 |
| B4 | `GET /strategies/{id}/performance/daily` — the one genuinely new piece of logic; exact data-access method is §7's open decision | B1, and possibly a small quantboard-pandapath change (§7) |
| B5 | Point the extension's Phase 3 plan (P12/P13) at this backend instead of mock data; retire/replace the mock `fetchStrategyCatalog()` seam | B2–B4, Phase 3 P9–P11 |
| B5 | Hardening: honest "not enough history yet" states (§3), CORS for the extension's origin, basic request logging | B1–B4 |

**Not estimated in days yet** — deliberately, since real market-data wiring (§7) is a later phase with its own scope once API keys are provided.

---

## 7. Live market data — deferred, by design

The ported strategies (B2) need market data (spot price, option chain, OI depending on the strategy) to produce real signals. Per the user's explicit decision: **this is wired later**, once they provide the relevant broker/data-vendor API keys. For B1–B5, the market-data adapter interface is defined (so the ported strategy code is structured correctly from the start) but backed by a clearly-labeled mock/stub implementation — real signals are not expected until this phase lands. A strategy that doesn't actually need a given data type (e.g. one that only needs spot price, not option chain) should not be forced to depend on it — port only what each strategy's real logic actually reads, per the user's "if not needed then don't consider" instruction.

---

## 8. Other open questions

1. **"Instrument" per strategy** — the reference screenshot shows each strategy card tagged with an instrument (e.g. "NIFTY"). In quantboard-pandapath, strategies aren't instrument-scoped — `symbol` (NIFTY/BANKNIFTY) is a query parameter passed to `/recommend` and `/strategies/evaluate`, not a property of the strategy itself. Does every strategy just run against whatever symbol the current chart tab is showing (most likely correct, and simplest), or do some strategies only make sense for one instrument?
2. ~~New backend's tech stack~~ **DECIDED**: Python + FastAPI, confirmed by the user ("fine, no issues").
3. ~~Where does the new repo live?~~ **DECIDED**: [github.com/sujaykurtikar/TradePilotBackend](https://github.com/sujaykurtikar/TradePilotBackend), created by the user.
4. ~~Order placement routing~~ **DECIDED**: not built in this backend for now (dummy/stub only if useful for testing); real path later is a direct DhanHQ API integration, not broker-website automation. See §3.
5. **CORS / extension origin** — once B1 exists, the new backend's CORS policy needs to explicitly allow the extension's `chrome-extension://<id>` origin.

---

## 9. Investigation: letting users bring their own strategy via Pine Script

Raised before scheduling further work: *"can we let a user paste their own Pine Script strategy and get signals from it?"* Investigated as pure technical/product research — nothing implemented, no code changed for this section.

### The core constraint
Pine Script is TradingView's own proprietary scripting language. It has **no public interpreter, no published language runtime, and no official API to execute a Pine script anywhere except inside TradingView's own charting engine** (their client, and their servers for alert evaluation). There is no legitimate way to take an arbitrary pasted Pine Script string and run it inside our own backend today — nobody outside TradingView (that I'm aware of) has an officially sanctioned way to do this, and unofficial third-party Pine-Script reimplementations exist but are incomplete, unmaintained against the real spec, and not something to build a paying feature on top of.

### The realistic option: TradingView webhook alerts (industry-standard pattern)
This is how essentially every third-party "connect your own TradingView strategy to a bot" product works (crypto trading bots, Discord/Telegram signal relays, etc.), and it needs **zero Pine Script execution on our side**:

1. The user writes their own Pine Script **strategy or indicator** normally, in their own TradingView account, on their own chart.
2. They add an `alert()` call (or an `alertcondition()`) to their script, and create a TradingView **alert** with **"Webhook URL"** enabled, pointing at an endpoint on our new backend (e.g. `POST /webhooks/tradingview/{user_token}`), with a JSON message template they control (e.g. `{"strategy_id": "...", "direction": "long", "strike": "{{close}}", ...}` using TradingView's placeholder syntax).
3. TradingView's own servers evaluate the script and fire the HTTP POST whenever the alert condition is true — the script executes entirely on TradingView's infrastructure, not ours.
4. Our backend receives that webhook, validates the payload, and treats it as a `StrategySignal` from a "custom" strategy, feeding the same Signals-tab concept already planned (§3/§4 above) alongside the built-in quantboard-pandapath strategies.

**Real constraints on this path, not glossed over:**
- **TradingView plan tier**: webhook alerts require a paid TradingView plan (their free tier does not support webhook alerts) — this is the user's own TradingView subscription, not something we control.
- **The alert must exist and be enabled on TradingView** — once created on a paid plan, it runs server-side (doesn't need the user's browser open), but the user still has to go create it there; we can't create it on their behalf via any public API TradingView offers for this.
- **We only get what the alert message template sends** — no OHLCV history, no arbitrary re-querying of the strategy's internal state; the payload is exactly whatever JSON the user configured, so onboarding needs a clear, copy-pasteable message-template format we define and validate against.
- **No sandboxing risk on our side** — since we never execute the user's code, there's no code-injection/sandbox-escape surface to defend against, which is a real security advantage over the alternative below.

### The alternative (not recommended for now): let users write a strategy in OUR system directly
Since quantboard-pandapath already has a clean `BaseStrategy`/`StrategySignal` Python interface (§1), a further-future option is a "bring your own strategy" mode where advanced users submit actual code against *our* interface, not Pine Script. This is a materially different, larger, and riskier feature — executing arbitrary user-submitted code requires real sandboxing (containerization, resource/time limits, no filesystem/network access from inside the sandbox) to avoid it becoming a remote-code-execution hole in a system that also places real orders. Not something to scope casually alongside this backend's other work; flagging as a possible future direction only, not part of this plan's current build order.

### One caveat on the "build our own Pine Script interpreter" idea
Worth naming since it's the most literal reading of the original question: independently reimplementing Pine Script's language spec (like a couple of small open-source community attempts do, incompletely) is possible in principle, but is a multi-month language-engineering undertaking with an ongoing maintenance burden every time TradingView revises the spec, and it sits in a legal gray area around reimplementing a proprietary vendor's language that I'm not positioned to give you a confident ruling on — worth your own legal read if you want to seriously pursue it. Not recommended as a near-term path given the webhook approach above achieves the same practical outcome (user's own custom logic → a signal our system consumes) with none of that cost or risk.

### Recommendation
**Webhook-based ingestion — deferred.** The user has confirmed this is a **later phase**, not part of the current build order. It's the standard pattern, requires no Pine Script execution or interpretation, and slots cleanly into the existing "strategy → signal" model this whole plan is already built around — a custom webhook-fed strategy would just become one more entry in the Signals tab next to the ported ones. Kept here as **B6 — custom strategy webhook ingestion (deferred, not scheduled)**.

---

## 10. What happens first

1. §8.1 (instrument-scoping) is the one remaining open question that affects B2/B3's shape — everything else needed to start is decided.
2. B1–B4 (scaffold → port strategies with mock market data → catalog/signal endpoints → own performance history) is the current, scheduled build order. B5 (webhook ingestion) stays deferred until asked for.
3. Once this backend is real, revisit `IMPLEMENTATION_PLAN_STRATEGIES_SIGNALS.md` §8's open question 1 — it's now answered (yes, real per-strategy signals exist, served from this isolated backend) — and update that plan's P12/P13 scope to call this backend instead of the mock dataset.
