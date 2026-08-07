/**
 * Side panel (Phase 3 / IMPLEMENTATION_PLAN_STRATEGIES_SIGNALS.md P9-P10):
 * persistent header (broker status + enable toggle + API status, folded in
 * from the old two-tab layout / popup) plus Signals / Strategies /
 * Learn Strategies tabs. Trading mode (manual vs strategy) is derived
 * elsewhere (Bootstrap.ts, P13) from `appliedStrategyIds.length` — this
 * file only reads/writes that state, it doesn't interpret it.
 *
 * Content here is intentionally simple (P11/P12 add filters, favorites,
 * alerts, the filter drawer) — P10's job was the structural shell; this
 * goes slightly beyond "just a placeholder" so the tabs are actually usable
 * while P11/P12 polish lands.
 */

import { SidePanelStorageManager } from '../src/core/storage/SidePanelStorageManager';
import { StorageManager } from '../src/core/storage/StorageManager';
import { fetchStrategyCatalog } from '../src/core/strategies/strategyCatalog';
import { strategyBackendClient } from '../src/core/api/strategyBackendClient';
import { sendToBackground } from '../src/core/messaging/MessageBus';
import type { StatusResponse } from '../src/core/messaging/messages';
import type { BrokerConnection, StrategyV2 } from '../src/core/storage/sidePanelSchema';
import { getLogger } from '../src/utils/logger';

const log = getLogger('sidepanel');
const sidePanelStorage = new SidePanelStorageManager();
const widgetStorage = new StorageManager();

// Populated on init from TradePilotBackend's /strategies/catalog (normalized
// underscore ids, e.g. "confluence_core"), null until that fetch resolves
// (attempted) or fails (stays null — every card shows as mock). Never
// silently presented as real without this check (plan §4's fetch-layer
// honesty requirement).
let liveBackendStrategyIds: ReadonlySet<string> | null = null;

function normalizeId(id: string): string {
  return id.replace(/-/g, '_');
}

function isLiveBacked(strategyId: string): boolean {
  return liveBackendStrategyIds?.has(normalizeId(strategyId)) ?? false;
}

interface BrokerDef {
  readonly id: string;
  readonly name: string;
  readonly recommended?: boolean;
}

// Static for now (§ user request) — same list shape as the reference
// mockup. Order/labels can grow without touching storage or layout code.
const BROKERS: readonly BrokerDef[] = [
  { id: 'lemonn', name: 'Lemonn', recommended: true },
  { id: 'coinswitch', name: 'CoinSwitch', recommended: true },
  { id: 'dhan', name: 'Dhan' },
  { id: 'groww915', name: '915 by Groww' },
  { id: 'zerodha', name: 'Zerodha Kite' },
  { id: 'angelone', name: 'Angel One' },
  { id: 'upstox', name: 'Upstox' },
];

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`sidepanel.html is missing #${id}`);
  return el as T;
}

function initials(name: string): string {
  return name.charAt(0).toUpperCase();
}

let openBrokerId: string | null = null;
let catalogCache: readonly StrategyV2[] | null = null;

function getCatalog(): readonly StrategyV2[] {
  // Mock catalog is deterministic per load (see strategyCatalog.ts) — cache
  // once per session so re-renders don't reshuffle todaysReturns, etc.
  if (catalogCache === null) catalogCache = fetchStrategyCatalog();
  return catalogCache;
}

// ---------- Header: broker status, enable toggle, API status ----------

function renderHeaderBrokerStatus(brokers: Readonly<Record<string, BrokerConnection>>): void {
  const connected = Object.values(brokers)[0] ?? null;
  byId<HTMLSpanElement>('header-broker-avatar').textContent = connected
    ? initials(connected.name)
    : '·';
  byId<HTMLSpanElement>('header-broker-text').textContent = connected
    ? `${connected.name} Connected`
    : 'No broker connected';
}

function applyApiStatusTooltip(status: StatusResponse['apiStatus']): void {
  const tooltip = byId<HTMLParagraphElement>('header-info-tooltip');
  const label =
    status === 'reachable' ? 'API reachable' : status === 'unreachable' ? 'API unreachable' : 'API status not checked';
  tooltip.textContent = label;
}

// ---------- Broker connect modal (opened from the header) ----------

function renderBrokerList(brokers: Readonly<Record<string, BrokerConnection>>): void {
  const list = byId<HTMLDivElement>('broker-list');
  list.textContent = '';

  for (const broker of BROKERS) {
    const connection = brokers[broker.id];
    const row = document.createElement('div');
    row.className = 'panel__broker-row';

    const identity = document.createElement('div');
    identity.className = 'panel__broker-identity';

    const avatar = document.createElement('div');
    avatar.className = 'panel__broker-avatar';
    avatar.textContent = initials(broker.name);

    const meta = document.createElement('div');
    meta.className = 'panel__broker-meta';

    const nameRow = document.createElement('div');
    nameRow.className = 'panel__broker-name-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'panel__broker-name';
    nameEl.textContent = broker.name;
    nameRow.appendChild(nameEl);
    if (broker.recommended) {
      const badge = document.createElement('span');
      badge.className = 'panel__broker-badge';
      badge.textContent = 'Recommended';
      nameRow.appendChild(badge);
    }

    const statusEl = document.createElement('span');
    statusEl.className = 'panel__broker-status-label';
    if (connection) {
      statusEl.textContent = 'Logged in';
      statusEl.classList.add('panel__broker-status-label--connected');
    } else {
      statusEl.textContent = 'Not logged in';
    }

    meta.append(nameRow, statusEl);
    identity.append(avatar, meta);

    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = connection ? 'panel__button panel__button--danger' : 'panel__button';
    actionButton.textContent = connection ? 'Disconnect' : 'Open';
    actionButton.addEventListener('click', () => {
      if (connection) {
        void disconnectBroker(broker.id);
      } else {
        openBrokerModal(broker);
      }
    });

    row.append(identity, actionButton);
    list.appendChild(row);
  }
}

function openBrokerModal(broker: BrokerDef): void {
  openBrokerId = broker.id;
  byId<HTMLHeadingElement>('broker-modal-title').textContent = `Connect ${broker.name}`;
  byId<HTMLInputElement>('broker-api-key').value = '';
  byId<HTMLInputElement>('broker-api-secret').value = '';
  byId<HTMLDivElement>('broker-modal').hidden = false;
}

function closeBrokerModal(): void {
  openBrokerId = null;
  byId<HTMLDivElement>('broker-modal').hidden = true;
}

async function disconnectBroker(brokerId: string): Promise<void> {
  const current = await sidePanelStorage.load();
  const next = { ...current.brokers };
  delete next[brokerId];
  const state = await sidePanelStorage.patch({ brokers: next });
  renderBrokerList(state.brokers);
  renderHeaderBrokerStatus(state.brokers);
}

// ---------- Strategies tab ----------

function renderDailyDots(days: readonly ('win' | 'loss')[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'panel__daily-dots';
  const labels = ['M', 'T', 'W', 'T', 'F'];
  for (let i = 0; i < 5; i++) {
    const dot = document.createElement('span');
    const result = days[i];
    dot.className =
      'panel__daily-dot' +
      (result === 'win' ? ' panel__daily-dot--win' : result === 'loss' ? ' panel__daily-dot--loss' : '');
    dot.title = labels[i] ?? '';
    dot.textContent = labels[i] ?? '';
    wrap.appendChild(dot);
  }
  return wrap;
}

function renderStrategyCard(strategy: StrategyV2, applied: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'panel__strategy-card' + (applied ? ' panel__strategy-card--applied' : '');

  const top = document.createElement('div');
  top.className = 'panel__strategy-card-top';

  const identity = document.createElement('div');
  identity.className = 'panel__strategy-identity';
  const avatar = document.createElement('span');
  avatar.className = 'panel__strategy-avatar';
  avatar.textContent = '⇄';
  const meta = document.createElement('div');
  const nameRow = document.createElement('div');
  nameRow.className = 'panel__strategy-name-row';
  const name = document.createElement('span');
  name.className = 'panel__strategy-name';
  name.textContent = strategy.name;
  nameRow.appendChild(name);
  const sourceTag = document.createElement('span');
  sourceTag.className = isLiveBacked(strategy.id)
    ? 'panel__source-tag panel__source-tag--live'
    : 'panel__source-tag panel__source-tag--mock';
  sourceTag.textContent = isLiveBacked(strategy.id) ? 'Live' : 'Mock';
  nameRow.appendChild(sourceTag);
  const sub = document.createElement('div');
  sub.className = 'panel__strategy-sub';
  sub.textContent = `${strategy.instrument} · Win rate ${strategy.winRatePct}%`;
  meta.append(nameRow, sub);
  identity.append(avatar, meta);

  const actionButton = document.createElement('button');
  actionButton.type = 'button';
  actionButton.className = applied ? 'panel__button panel__button--outline' : 'panel__button panel__button--primary';
  actionButton.textContent = applied ? 'Remove' : 'Apply';
  actionButton.addEventListener('click', () => void toggleApplied(strategy.id, !applied));

  top.append(identity, actionButton);

  const bottom = document.createElement('div');
  bottom.className = 'panel__strategy-card-bottom';

  const lastWeek = document.createElement('div');
  const lastWeekLabel = document.createElement('div');
  lastWeekLabel.className = 'panel__strategy-stat-label';
  lastWeekLabel.textContent = 'Last week';
  lastWeek.appendChild(lastWeekLabel);
  lastWeek.appendChild(renderDailyDots(strategy.lastWeekDaily));

  const todayReturns = document.createElement('div');
  const todayLabel = document.createElement('div');
  todayLabel.className = 'panel__strategy-stat-label';
  todayLabel.textContent = "Today's Returns";
  const todayValue = document.createElement('div');
  todayValue.className =
    'panel__strategy-returns' + (strategy.todayReturnsPct < 0 ? ' panel__strategy-returns--negative' : '');
  todayValue.textContent = `${strategy.todayReturnsPct > 0 ? '+' : ''}${strategy.todayReturnsPct.toFixed(2)}%`;
  todayReturns.append(todayLabel, todayValue);

  bottom.append(lastWeek, todayReturns);
  card.append(top, bottom);
  return card;
}

async function toggleApplied(strategyId: string, apply: boolean): Promise<void> {
  const current = await sidePanelStorage.load();
  const applied = new Set(current.appliedStrategyIds);
  if (apply) {
    applied.add(strategyId);
  } else {
    applied.delete(strategyId);
  }
  const appliedStrategyIds = [...applied];
  // If the removed strategy was active, clear active; if nothing is active
  // yet and something just got applied, make it active by default.
  let activeStrategyId = current.activeStrategyId;
  if (!apply && activeStrategyId === strategyId) activeStrategyId = appliedStrategyIds[0] ?? null;
  if (apply && activeStrategyId === null) activeStrategyId = strategyId;

  const state = await sidePanelStorage.patch({ appliedStrategyIds, activeStrategyId });
  renderStrategiesTab(state);
  renderSignalsTab(state);
}

async function setActiveStrategy(strategyId: string): Promise<void> {
  const state = await sidePanelStorage.patch({ activeStrategyId: strategyId });
  renderSignalsTab(state);
}

function renderStrategiesTab(state: { appliedStrategyIds: readonly string[]; strategies: readonly StrategyV2[] }): void {
  const catalog = getCatalog();
  const applied = new Set(state.appliedStrategyIds);
  byId<HTMLSpanElement>('strategies-count').textContent = String(catalog.length);

  const list = byId<HTMLDivElement>('strategy-catalog-list');
  list.textContent = '';
  for (const strategy of catalog) {
    list.appendChild(renderStrategyCard(strategy, applied.has(strategy.id)));
  }

  renderCustomStrategyList(state.strategies);
}

function renderCustomStrategyList(strategies: readonly StrategyV2[]): void {
  // Custom (user-added) strategies are kept separate from the mock catalog
  // above — this preserves the pre-P9 "Add strategy" note-taking feature
  // rather than dropping it.
  const existing = document.getElementById('custom-strategy-list');
  existing?.remove();
  if (strategies.length === 0) return;

  const form = byId<HTMLFormElement>('strategy-form');
  const list = document.createElement('div');
  list.id = 'custom-strategy-list';
  list.className = 'panel__strategy-list';
  for (const strategy of [...strategies].sort((a, b) => b.createdAt - a.createdAt)) {
    const card = document.createElement('div');
    card.className = 'panel__strategy-card';
    const name = document.createElement('h3');
    name.className = 'panel__strategy-name';
    name.textContent = strategy.name;
    const notes = document.createElement('p');
    notes.className = 'panel__strategy-notes';
    notes.textContent = strategy.notes;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'panel__button panel__button--danger';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => void removeCustomStrategy(strategy.id));
    card.append(name, notes, removeButton);
    list.appendChild(card);
  }
  form.insertAdjacentElement('afterend', list);
}

async function removeCustomStrategy(strategyId: string): Promise<void> {
  const current = await sidePanelStorage.load();
  const strategies = current.strategies.filter((s) => s.id !== strategyId);
  const state = await sidePanelStorage.patch({ strategies });
  renderStrategiesTab(state);
}

// ---------- Signals tab ----------

function renderSignalsTab(state: {
  appliedStrategyIds: readonly string[];
  activeStrategyId: string | null;
}): void {
  const container = byId<HTMLDivElement>('signals-content');
  container.textContent = '';

  if (state.appliedStrategyIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel__empty-state';
    const icon = document.createElement('div');
    icon.className = 'panel__empty-icon';
    icon.textContent = '💡';
    const text = document.createElement('p');
    text.textContent = 'No signals yet — apply a strategy to see live signals here, or trade manually on the chart.';
    empty.append(icon, text);
    container.appendChild(empty);
    return;
  }

  const catalog = getCatalog();
  const byIdMap = new Map(catalog.map((s) => [s.id, s]));

  for (const strategyId of state.appliedStrategyIds) {
    const strategy = byIdMap.get(strategyId);
    if (strategy === undefined) continue;

    const card = document.createElement('div');
    card.className = 'panel__strategy-card';
    if (strategyId === state.activeStrategyId) card.classList.add('panel__strategy-card--applied');

    const top = document.createElement('div');
    top.className = 'panel__strategy-card-top';
    const name = document.createElement('div');
    name.className = 'panel__strategy-name';
    name.textContent = strategy.name;

    const activeControl = document.createElement('label');
    activeControl.className = 'panel__active-radio';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'active-strategy';
    radio.checked = strategyId === state.activeStrategyId;
    radio.addEventListener('change', () => void setActiveStrategy(strategyId));
    activeControl.append(radio, document.createTextNode(' Active on chart'));

    top.append(name, activeControl);

    const sub = document.createElement('p');
    sub.className = 'panel__strategy-sub';
    sub.textContent = `${strategy.instrument} · Win rate ${strategy.winRatePct}% · Today ${strategy.todayReturnsPct > 0 ? '+' : ''}${strategy.todayReturnsPct.toFixed(2)}%`;

    card.append(top, sub);
    container.appendChild(card);
  }
}

// ---------- Tabs ----------

function switchTab(tab: 'signals' | 'strategies' | 'learn'): void {
  byId<HTMLButtonElement>('tab-signals').classList.toggle('panel__tab--active', tab === 'signals');
  byId<HTMLButtonElement>('tab-strategies').classList.toggle('panel__tab--active', tab === 'strategies');
  byId<HTMLButtonElement>('tab-learn').classList.toggle('panel__tab--active', tab === 'learn');
  byId<HTMLElement>('view-signals').hidden = tab !== 'signals';
  byId<HTMLElement>('view-strategies').hidden = tab !== 'strategies';
  byId<HTMLElement>('view-learn').hidden = tab !== 'learn';
}

// ---------- Init ----------

async function init(): Promise<void> {
  const sidePanelState = await sidePanelStorage.load();
  renderHeaderBrokerStatus(sidePanelState.brokers);
  renderBrokerList(sidePanelState.brokers);
  renderStrategiesTab(sidePanelState);
  renderSignalsTab(sidePanelState);

  // Try the real backend; on any failure (unreachable, timeout, non-2xx)
  // liveBackendStrategyIds stays null and every card keeps showing "Mock" —
  // never silently presented as real (plan §4).
  void strategyBackendClient.fetchCatalog().then((catalog) => {
    if (catalog === null) {
      log.info('strategy backend unreachable — showing mock catalog only');
      return;
    }
    log.info('strategy backend reachable', { count: catalog.length });
    liveBackendStrategyIds = new Set(catalog.map((entry) => entry.id));
    renderStrategiesTab(sidePanelState);
  });

  const widgetState = await widgetStorage.load();
  byId<HTMLInputElement>('header-enabled-toggle').checked = widgetState.enabled;
  byId<HTMLInputElement>('header-trading-mode-toggle').checked =
    widgetState.tradingMode === 'personal';

  byId<HTMLButtonElement>('tab-signals').addEventListener('click', () => switchTab('signals'));
  byId<HTMLButtonElement>('tab-strategies').addEventListener('click', () => switchTab('strategies'));
  byId<HTMLButtonElement>('tab-learn').addEventListener('click', () => switchTab('learn'));

  byId<HTMLButtonElement>('header-broker-status').addEventListener('click', () => {
    byId<HTMLDivElement>('broker-list-modal').hidden = false;
  });
  byId<HTMLButtonElement>('broker-list-close').addEventListener('click', () => {
    byId<HTMLDivElement>('broker-list-modal').hidden = true;
  });

  byId<HTMLInputElement>('header-enabled-toggle').addEventListener('change', (event) => {
    void widgetStorage.patch({ enabled: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLInputElement>('header-trading-mode-toggle').addEventListener('change', (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    void widgetStorage.patch({ tradingMode: checked ? 'personal' : 'strategy' });
  });

  const infoButton = byId<HTMLButtonElement>('header-info-button');
  const infoTooltip = byId<HTMLParagraphElement>('header-info-tooltip');
  infoButton.addEventListener('click', () => {
    infoTooltip.hidden = !infoTooltip.hidden;
  });

  byId<HTMLButtonElement>('broker-cancel').addEventListener('click', closeBrokerModal);

  byId<HTMLFormElement>('broker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (openBrokerId === null) return;
    const brokerId = openBrokerId;
    const apiKey = byId<HTMLInputElement>('broker-api-key').value.trim();
    const apiSecret = byId<HTMLInputElement>('broker-api-secret').value.trim();
    if (apiKey === '' || apiSecret === '') return;

    void (async () => {
      const current = await sidePanelStorage.load();
      const connection: BrokerConnection = {
        id: brokerId,
        name: BROKERS.find((b) => b.id === brokerId)?.name ?? brokerId,
        apiKey,
        apiSecret,
        connectedAt: Date.now(),
      };
      const result = await sidePanelStorage.patch({
        brokers: { ...current.brokers, [brokerId]: connection },
      });
      renderBrokerList(result.brokers);
      renderHeaderBrokerStatus(result.brokers);
      closeBrokerModal();
    })();
  });

  byId<HTMLFormElement>('strategy-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const nameInput = byId<HTMLInputElement>('strategy-name');
    const notesInput = byId<HTMLTextAreaElement>('strategy-notes');
    const name = nameInput.value.trim();
    if (name === '') return;

    void (async () => {
      const current = await sidePanelStorage.load();
      const strategy: StrategyV2 = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        notes: notesInput.value.trim(),
        createdAt: Date.now(),
        instrument: 'NIFTY',
        winRatePct: 0,
        lastWeekDaily: [],
        todayReturnsPct: 0,
        favorite: false,
        alertsEnabled: false,
      };
      const result = await sidePanelStorage.patch({ strategies: [...current.strategies, strategy] });
      renderStrategiesTab(result);
      nameInput.value = '';
      notesInput.value = '';
    })();
  });

  sidePanelStorage.onChange((next) => {
    renderHeaderBrokerStatus(next.brokers);
    renderBrokerList(next.brokers);
    renderStrategiesTab(next);
    renderSignalsTab(next);
  });

  widgetStorage.onChange((next) => {
    byId<HTMLInputElement>('header-enabled-toggle').checked = next.enabled;
    byId<HTMLInputElement>('header-trading-mode-toggle').checked = next.tradingMode === 'personal';
  });

  const status = await sendToBackground<StatusResponse>({ type: 'tradepilot/get-status' });
  applyApiStatusTooltip(status?.apiStatus ?? 'not-checked');
}

init().catch((error: unknown) => {
  log.error('sidepanel init failed', { error: String(error) });
});
