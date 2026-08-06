import { describe, it, expect } from 'vitest';
import { TabRegistry } from '../src/background/TabRegistry';

describe('TabRegistry', () => {
  it('a newly registered tab is assumed visible', () => {
    const reg = new TabRegistry();
    reg.register(1);
    expect(reg.anyVisible()).toBe(true);
    expect(reg.activeTabIds()).toEqual([1]);
  });

  it('setVisibility updates a registered tab', () => {
    const reg = new TabRegistry();
    reg.register(1);
    reg.setVisibility(1, false);
    expect(reg.anyVisible()).toBe(false);
  });

  it('setVisibility on an unregistered tab is ignored (not silently created)', () => {
    const reg = new TabRegistry();
    reg.setVisibility(99, true);
    expect(reg.activeTabIds()).toEqual([]);
  });

  it('anyVisible() is true if ANY registered tab is visible', () => {
    const reg = new TabRegistry();
    reg.register(1);
    reg.register(2);
    reg.setVisibility(1, false);
    reg.setVisibility(2, true);
    expect(reg.anyVisible()).toBe(true);
  });

  it('unregister removes a tab entirely — a closed tab cannot keep the poller alive', () => {
    const reg = new TabRegistry();
    reg.register(1);
    reg.unregister(1);
    expect(reg.anyVisible()).toBe(false);
    expect(reg.activeTabIds()).toEqual([]);
  });
});
