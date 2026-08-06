/**
 * Small generic observable store, shared by any context that needs
 * "current value + subscribe to changes" without pulling in a framework.
 * Distinct from widget/managers/StateManager (that one is UI-only widget
 * state); this is the general-purpose version background/content code can
 * reuse (e.g. P5's cached suggestion/position data).
 */

export class Store<T> {
  private value: T;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    for (const listener of this.listeners) listener(next);
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
  }
}
