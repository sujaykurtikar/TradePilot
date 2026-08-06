/**
 * Tracks which tabs currently have a TradePilot content script alive, and
 * each one's visibility — the two facts DataPoller's `shouldPoll` gate
 * needs (§P5: "poll only when the tab is visible"), and the target list
 * for pushing data updates (§P5: "pushes to the content script").
 *
 * "Active" is defined by the content-lifecycle port connection
 * (background/index.ts already accepts this for teardown detection,
 * §7.4/§7.5) — its onDisconnect is what removes a tab here, so a closed
 * tab or reloaded page can't leak a stale visible=true entry forever.
 */

export class TabRegistry {
  private readonly visibility = new Map<number, boolean>();

  register(tabId: number): void {
    if (!this.visibility.has(tabId)) this.visibility.set(tabId, true); // assume visible until told otherwise
  }

  unregister(tabId: number): void {
    this.visibility.delete(tabId);
  }

  setVisibility(tabId: number, visible: boolean): void {
    if (!this.visibility.has(tabId)) return; // not a registered tab — ignore
    this.visibility.set(tabId, visible);
  }

  anyVisible(): boolean {
    for (const visible of this.visibility.values()) {
      if (visible) return true;
    }
    return false;
  }

  activeTabIds(): readonly number[] {
    return [...this.visibility.keys()];
  }
}
