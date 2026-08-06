/**
 * Composes the three independently-positionable elements (§R-P3) into the
 * widget shown on-chart: TP pill above, Suggested card riding the live
 * price, SL pill below (§P3 screenshot). Owns the ShadowHost, DragManager,
 * AnchorManager, and collapse-to-puck state for this one widget instance.
 *
 * Knows nothing about TradingView/Kotak — only the ChartBridge interface
 * (§5.1). Knows nothing about our backend either — suggestion data and the
 * Trade callback are handed in by the caller (content/Bootstrap.ts), which
 * for Day-1 (§6.0) is a hardcoded config object, and from P5/P6 onward is
 * real API data. This class doesn't change between those two states.
 */

import type { ChartBridge } from '../bridge/ChartBridge';
import { AnchorManager } from './managers/AnchorManager';
import { DragManager } from './managers/DragManager';
import { StateManager } from './managers/StateManager';
import { ShadowHost } from './ShadowHost';
import { createLevelPill, type LevelPillComponent } from './components/LevelPill';
import { createSuggestionCard, type SuggestionCardComponent } from './components/SuggestionCard';
import { showToast } from './components/Toast';
import { getLogger } from '../utils/logger';

const log = getLogger('widget:root');

export interface WidgetSuggestionData {
  readonly symbolLabel: string;
  readonly subLabel?: string | null;
  /** Anchor reference for the card riding the live price — see class header. */
  readonly livePrice: () => number | null;
  readonly tp: number | null;
  readonly sl: number | null;
  readonly tradeDisabled?: boolean;
  readonly staleReason?: string | null;
  readonly onTrade: () => void;
}

export interface WidgetRootOptions {
  readonly bridge: ChartBridge;
  readonly suggestion: WidgetSuggestionData;
  /** §6.0: Day-1 build must carry a visible "DEMO" badge so it's never mistaken for the hardened version. */
  readonly demoMode: boolean;
}

const TARGET_TP = 'level-pill-tp';
const TARGET_SL = 'level-pill-sl';
const TARGET_SUGGESTION = 'suggestion-card';

export class WidgetRoot {
  private readonly host: ShadowHost;
  private readonly dragManager = new DragManager();
  private readonly anchorManager: AnchorManager;
  private readonly stateManager = new StateManager();
  private readonly tpPill: LevelPillComponent;
  private readonly slPill: LevelPillComponent;
  private readonly suggestionCard: SuggestionCardComponent;
  private readonly puck: HTMLButtonElement;
  private readonly demoBadge: HTMLDivElement | null = null;
  private suggestion: WidgetSuggestionData;
  private unsubscribeState: (() => void) | null = null;

  constructor(opts: WidgetRootOptions) {
    this.suggestion = opts.suggestion;
    this.host = new ShadowHost();
    this.anchorManager = new AnchorManager(opts.bridge, this.dragManager);

    this.tpPill = createLevelPill({ variant: 'tp', price: opts.suggestion.tp });
    this.slPill = createLevelPill({ variant: 'sl', price: opts.suggestion.sl });
    this.suggestionCard = createSuggestionCard({
      symbolLabel: opts.suggestion.symbolLabel,
      subLabel: opts.suggestion.subLabel ?? null,
      tradeDisabled: opts.suggestion.tradeDisabled ?? false,
      staleReason: opts.suggestion.staleReason ?? null,
      onTrade: opts.suggestion.onTrade,
    });

    for (const el of [this.tpPill.element, this.slPill.element, this.suggestionCard.element]) {
      el.classList.add('tp-positioned', 'tp-mount-animate');
    }

    this.puck = document.createElement('button');
    this.puck.type = 'button';
    this.puck.className = 'tp-puck tp-positioned';
    this.puck.textContent = '⚡';
    this.puck.setAttribute('aria-label', 'Expand TradePilot widget');
    this.puck.addEventListener('click', () => this.stateManager.set({ collapsed: false }));

    if (opts.demoMode) {
      this.demoBadge = document.createElement('div');
      this.demoBadge.className = 'tp-badge-demo';
      this.demoBadge.textContent = 'DEMO';
    }

    this.host.layer.append(this.tpPill.element, this.suggestionCard.element, this.slPill.element, this.puck);
    if (this.demoBadge) this.host.layer.appendChild(this.demoBadge);

    this.dragManager.bind(TARGET_TP, this.tpPill.handleElement);
    this.dragManager.bind(TARGET_SL, this.slPill.handleElement);
    this.dragManager.bind(TARGET_SUGGESTION, this.suggestionCard.handleElement);

    this.anchorManager.addTarget({
      id: TARGET_TP,
      element: this.tpPill.element,
      getPrice: () => this.suggestion.tp,
      pinRight: true,
    });
    this.anchorManager.addTarget({
      id: TARGET_SL,
      element: this.slPill.element,
      getPrice: () => this.suggestion.sl,
      pinRight: true,
    });
    this.anchorManager.addTarget({
      id: TARGET_SUGGESTION,
      element: this.suggestionCard.element,
      getPrice: () => this.suggestion.livePrice(),
      pinRight: true,
    });

    this.unsubscribeState = this.stateManager.subscribe((state) => this.renderCollapseState(state.collapsed));
    this.renderCollapseState(this.stateManager.get().collapsed);
  }

  private renderCollapseState(collapsed: boolean): void {
    const display = (el: HTMLElement, show: boolean): void => {
      el.style.display = show ? '' : 'none';
    };
    display(this.tpPill.element, !collapsed);
    display(this.slPill.element, !collapsed);
    display(this.suggestionCard.element, !collapsed);
    display(this.puck, collapsed);
  }

  /** Called by content/Bootstrap.ts when new suggestion data arrives (hardcoded for Day-1, live from P5). */
  updateSuggestion(next: WidgetSuggestionData): void {
    this.suggestion = next;
    this.tpPill.update({ variant: 'tp', price: next.tp });
    this.slPill.update({ variant: 'sl', price: next.sl });
    this.suggestionCard.update({
      symbolLabel: next.symbolLabel,
      subLabel: next.subLabel ?? null,
      tradeDisabled: next.tradeDisabled ?? false,
      staleReason: next.staleReason ?? null,
      onTrade: next.onTrade,
    });
  }

  /** Shows a transient message inside this widget's own Shadow DOM layer (§6.0's Trade-click confirm stub, and reusable by P6's success/error notices). */
  showToast(message: string): void {
    showToast(this.host.layer, message);
  }

  async mount(): Promise<void> {
    if (ShadowHost.alreadyMounted()) {
      log.warn('widget host already mounted — refusing to double-mount (§R-P1)');
      return;
    }
    await this.host.loadStyles();
    this.host.mount();
    this.anchorManager.start();
    log.info('widget mounted');
  }

  /** Full teardown (§7.5/§R-P1) — every listener/observer/rAF released. */
  destroy(): void {
    this.anchorManager.dispose();
    this.dragManager.destroy();
    this.tpPill.destroy();
    this.slPill.destroy();
    this.suggestionCard.destroy();
    this.unsubscribeState?.();
    this.stateManager.destroy();
    this.host.destroy();
    log.info('widget destroyed');
  }
}
