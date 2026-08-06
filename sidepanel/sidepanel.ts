/**
 * Side panel: broker API-key connections + saved strategies. Both are
 * local-only (chrome.storage.local via SidePanelStorageManager) — this
 * extension never transmits either anywhere; "connected" just means a
 * key/secret pair is on file for the widget to read later once real
 * broker order submission (OrderService) is wired to use it.
 */

import { SidePanelStorageManager } from '../src/core/storage/SidePanelStorageManager';
import type { BrokerConnection, Strategy } from '../src/core/storage/sidePanelSchema';
import { getLogger } from '../src/utils/logger';

const log = getLogger('sidepanel');
const storage = new SidePanelStorageManager();

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

function renderBrokers(brokers: Readonly<Record<string, BrokerConnection>>): void {
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
    statusEl.className = 'panel__broker-status';
    if (connection) {
      statusEl.textContent = 'Logged in';
      statusEl.classList.add('panel__broker-status--connected');
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
  const current = await storage.load();
  const next = { ...current.brokers };
  delete next[brokerId];
  const state = await storage.patch({ brokers: next });
  renderBrokers(state.brokers);
}

function renderStrategies(strategies: readonly Strategy[]): void {
  const list = byId<HTMLDivElement>('strategy-list');
  list.textContent = '';

  if (strategies.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'panel__empty';
    empty.textContent = 'No strategies saved yet.';
    list.appendChild(empty);
    return;
  }

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
    removeButton.addEventListener('click', () => void removeStrategy(strategy.id));

    card.append(name, notes, removeButton);
    list.appendChild(card);
  }
}

async function removeStrategy(strategyId: string): Promise<void> {
  const current = await storage.load();
  const next = current.strategies.filter((s) => s.id !== strategyId);
  const state = await storage.patch({ strategies: next });
  renderStrategies(state.strategies);
}

function switchTab(tab: 'brokers' | 'strategy'): void {
  byId<HTMLButtonElement>('tab-brokers').classList.toggle('panel__tab--active', tab === 'brokers');
  byId<HTMLButtonElement>('tab-strategy').classList.toggle('panel__tab--active', tab === 'strategy');
  byId<HTMLElement>('view-brokers').hidden = tab !== 'brokers';
  byId<HTMLElement>('view-strategy').hidden = tab !== 'strategy';
}

async function init(): Promise<void> {
  const state = await storage.load();
  renderBrokers(state.brokers);
  renderStrategies(state.strategies);

  byId<HTMLButtonElement>('tab-brokers').addEventListener('click', () => switchTab('brokers'));
  byId<HTMLButtonElement>('tab-strategy').addEventListener('click', () => switchTab('strategy'));

  byId<HTMLButtonElement>('broker-cancel').addEventListener('click', closeBrokerModal);

  byId<HTMLFormElement>('broker-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (openBrokerId === null) return;
    const brokerId = openBrokerId;
    const apiKey = byId<HTMLInputElement>('broker-api-key').value.trim();
    const apiSecret = byId<HTMLInputElement>('broker-api-secret').value.trim();
    if (apiKey === '' || apiSecret === '') return;

    void (async () => {
      const current = await storage.load();
      const connection: BrokerConnection = {
        id: brokerId,
        name: BROKERS.find((b) => b.id === brokerId)?.name ?? brokerId,
        apiKey,
        apiSecret,
        connectedAt: Date.now(),
      };
      const result = await storage.patch({
        brokers: { ...current.brokers, [brokerId]: connection },
      });
      renderBrokers(result.brokers);
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
      const current = await storage.load();
      const strategy: Strategy = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        notes: notesInput.value.trim(),
        createdAt: Date.now(),
      };
      const result = await storage.patch({ strategies: [...current.strategies, strategy] });
      renderStrategies(result.strategies);
      nameInput.value = '';
      notesInput.value = '';
    })();
  });

  storage.onChange((next) => {
    renderBrokers(next.brokers);
    renderStrategies(next.strategies);
  });
}

init().catch((error: unknown) => {
  log.error('sidepanel init failed', { error: String(error) });
});
