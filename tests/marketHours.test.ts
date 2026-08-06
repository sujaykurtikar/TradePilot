import { describe, it, expect } from 'vitest';
import { isMarketOpenIst } from '../src/utils/marketHours';

// Verified against Node's own Intl.DateTimeFormat before writing these
// (not guessed): 2026-08-06T04:30:00Z is Thursday 10:00 IST;
// 2026-08-08T04:30:00Z is Saturday.
describe('isMarketOpenIst', () => {
  it('is open on a weekday during regular session hours (Thu 10:00 IST)', () => {
    expect(isMarketOpenIst(new Date('2026-08-06T04:30:00Z'))).toBe(true);
  });

  it('is closed on a weekday before the open (Thu 09:00 IST, open is 09:15)', () => {
    expect(isMarketOpenIst(new Date('2026-08-06T03:30:00Z'))).toBe(false);
  });

  it('is open exactly at the boundary minutes (09:15 and 15:30 IST)', () => {
    expect(isMarketOpenIst(new Date('2026-08-06T03:45:00Z'))).toBe(true); // 09:15 IST
    expect(isMarketOpenIst(new Date('2026-08-06T10:00:00Z'))).toBe(true); // 15:30 IST
  });

  it('is closed just after the close (Thu 15:31 IST)', () => {
    expect(isMarketOpenIst(new Date('2026-08-06T10:01:00Z'))).toBe(false);
  });

  it('is closed on a weekend even during regular session hours (Sat 10:00 IST)', () => {
    expect(isMarketOpenIst(new Date('2026-08-08T04:30:00Z'))).toBe(false);
  });
});
