/**
 * Minimal observable store for widget-level UI state (collapse/expand).
 * Deliberately tiny — this is not a general state-management framework,
 * just enough to let WidgetRoot and the popup agree on "collapsed or not"
 * (§P3: "Collapsible to a single puck... position and collapse state
 * persisted").
 */

export interface WidgetUiState {
  readonly collapsed: boolean;
}

const DEFAULT_STATE: WidgetUiState = { collapsed: false };

export class StateManager {
  private state: WidgetUiState;
  private readonly listeners = new Set<(state: WidgetUiState) => void>();

  constructor(initial: WidgetUiState = DEFAULT_STATE) {
    this.state = initial;
  }

  get(): WidgetUiState {
    return this.state;
  }

  set(patch: Partial<WidgetUiState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: WidgetUiState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
  }
}
