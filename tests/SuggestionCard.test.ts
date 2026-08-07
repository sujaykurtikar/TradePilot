import { describe, it, expect, vi } from 'vitest';
import { createSuggestionCard } from '../src/widget/components/SuggestionCard';

describe('SuggestionCard — normal view (personalEntry absent, §additive guarantee)', () => {
  it('renders the normal Suggested body when personalEntry is null/absent', () => {
    const card = createSuggestionCard({
      symbolLabel: '24120 CE',
      onTrade: () => {},
    });
    expect(card.element.querySelector('.tp-card__symbol')?.textContent).toBe('24120 CE');
    expect((card.element.querySelector('.tp-card__entry') as HTMLElement).style.display).toBe(
      'none',
    );
    card.destroy();
  });
});

describe('SuggestionCard — §4 personal-mode entry view', () => {
  it('shows the entry view instead of the normal body when personalEntry is set', () => {
    const card = createSuggestionCard({
      symbolLabel: 'NIFTY CE',
      onTrade: () => {},
      personalEntry: {
        direction: null,
        strikeOffsetSteps: 0,
        onPickDirection: () => {},
        onStepStrike: () => {},
      },
    });
    const body = card.element.querySelector('.tp-card__body') as HTMLElement;
    const entry = card.element.querySelector('.tp-card__entry') as HTMLElement;
    expect(body.style.display).toBe('none');
    expect(entry.style.display).toBe('');
    expect(entry.querySelector('.tp-card__title')?.textContent).toBe('Personal');
    card.destroy();
  });

  it('BUY/SELL buttons call onPickDirection with the picked side', () => {
    const onPickDirection = vi.fn();
    const card = createSuggestionCard({
      symbolLabel: 'NIFTY CE',
      onTrade: () => {},
      personalEntry: {
        direction: null,
        strikeOffsetSteps: 0,
        onPickDirection,
        onStepStrike: () => {},
      },
    });
    const buyBtn = card.element.querySelector(
      '.tp-card__entry-dir-btn--buy',
    ) as HTMLButtonElement;
    const sellBtn = card.element.querySelector(
      '.tp-card__entry-dir-btn--sell',
    ) as HTMLButtonElement;
    buyBtn.click();
    expect(onPickDirection).toHaveBeenCalledWith('BUY');
    sellBtn.click();
    expect(onPickDirection).toHaveBeenCalledWith('SELL');
    card.destroy();
  });

  it('the stepper buttons call onStepStrike with +1/-1 and the label reflects strikeOffsetSteps', () => {
    const onStepStrike = vi.fn();
    const card = createSuggestionCard({
      symbolLabel: 'NIFTY CE',
      onTrade: () => {},
      personalEntry: {
        direction: 'BUY',
        strikeOffsetSteps: 2,
        onPickDirection: () => {},
        onStepStrike,
      },
    });
    expect(card.element.querySelector('.tp-card__entry-step-label')?.textContent).toBe('ATM+2');
    const [stepDownBtn, stepUpBtn] = card.element.querySelectorAll(
      '.tp-card__entry-step-btn',
    ) as unknown as [HTMLButtonElement, HTMLButtonElement];
    stepDownBtn.click();
    expect(onStepStrike).toHaveBeenCalledWith(-1);
    stepUpBtn.click();
    expect(onStepStrike).toHaveBeenCalledWith(1);
    card.destroy();
  });

  it('hides the symbol line until a direction is picked, then shows symbolLabel/subLabel', () => {
    const card = createSuggestionCard({
      symbolLabel: 'NIFTY CE',
      subLabel: 'LTP 24120',
      onTrade: () => {},
      personalEntry: {
        direction: null,
        strikeOffsetSteps: 0,
        onPickDirection: () => {},
        onStepStrike: () => {},
      },
    });
    const symbolEls = card.element.querySelectorAll('.tp-card__symbol');
    // one lives in the (hidden) normal body, one in the entry view
    const entrySymbol = card.element.querySelector('.tp-card__entry .tp-card__symbol') as HTMLElement;
    expect(entrySymbol.style.display).toBe('none');
    expect(symbolEls.length).toBeGreaterThan(0);

    card.update({
      symbolLabel: 'NIFTY CE',
      subLabel: 'LTP 24120',
      onTrade: () => {},
      personalEntry: {
        direction: 'BUY',
        strikeOffsetSteps: 0,
        onPickDirection: () => {},
        onStepStrike: () => {},
      },
    });
    expect(entrySymbol.style.display).toBe('');
    expect(entrySymbol.textContent).toBe('NIFTY CE');
    card.destroy();
  });

  it('the entry Trade button is disabled while tradeDisabled, and clicking it calls onTrade when enabled', () => {
    const onTrade = vi.fn();
    const card = createSuggestionCard({
      symbolLabel: 'NIFTY CE',
      onTrade,
      tradeDisabled: true,
      personalEntry: {
        direction: 'BUY',
        strikeOffsetSteps: 0,
        onPickDirection: () => {},
        onStepStrike: () => {},
      },
    });
    const entryTradeBtn = card.element.querySelector(
      '.tp-card__entry .tp-card__trade-btn',
    ) as HTMLButtonElement;
    expect(entryTradeBtn.disabled).toBe(true);
    entryTradeBtn.click();
    expect(onTrade).not.toHaveBeenCalled();

    card.update({
      symbolLabel: 'NIFTY CE',
      onTrade,
      tradeDisabled: false,
      personalEntry: {
        direction: 'BUY',
        strikeOffsetSteps: 0,
        onPickDirection: () => {},
        onStepStrike: () => {},
      },
    });
    expect(entryTradeBtn.disabled).toBe(false);
    entryTradeBtn.click();
    expect(onTrade).toHaveBeenCalledTimes(1);
    card.destroy();
  });

  it('a confirm still takes precedence over personalEntry (confirm view wins)', () => {
    const card = createSuggestionCard({
      symbolLabel: 'NIFTY CE',
      onTrade: () => {},
      personalEntry: {
        direction: 'BUY',
        strikeOffsetSteps: 0,
        onPickDirection: () => {},
        onStepStrike: () => {},
      },
      confirm: {
        direction: 'BUY',
        strikeLabel: 'NIFTY CE',
        lots: 1,
        entryPrice: 24120,
        sl: null,
        tp: null,
        riskRupees: null,
        onConfirm: () => {},
        onCancel: () => {},
      },
    });
    const entry = card.element.querySelector('.tp-card__entry') as HTMLElement;
    const confirmView = card.element.querySelector('.tp-card__confirm') as HTMLElement;
    expect(entry.style.display).toBe('none');
    expect(confirmView.style.display).toBe('');
    card.destroy();
  });
});
