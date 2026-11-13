// Regression guard: the expiry clock used to build an Intl.DateTimeFormat on every call, which
// made a single position analysis take over a second (tens of thousands of calls per analysis).
import { describe, it, expect, vi } from 'vitest';
import { expiryMs, parseLeg, probability, riskGrid } from '../src/index.ts';

describe('expiry clock', () => {
  it('builds no date formatter while analysing a position', () => {
    expiryMs('2026-12-04'); // warm the cache for this date
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    const legs = [
      '+1 P 150 2026-12-04 @2.83',
      '-1 P 160 2026-12-04 @5.42',
      '-1 C 180 2026-12-04 @6.42',
      '+1 C 190 2026-12-04 @3.56',
    ].map((l) => parseLeg(`${l} iv=0.6`));
    const m = { S: 170.89, r: 0.04, q: 0, now: Date.parse('2026-11-13T19:30:00Z') };
    const p = probability(legs, m);
    const g = riskGrid(legs, m, { ivShifts: [-0.15, 0, 0.15], steps: 88 });
    expect(p.breakevens.length).toBe(2);
    expect(g.rows.length).toBe(15);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('still gives 16:00 New York on both sides of a clock change, cached or not', () => {
    for (let i = 0; i < 2; i++) {
      expect(new Date(expiryMs('2026-07-17')).toISOString()).toBe('2026-07-17T20:00:00.000Z'); // EDT
      expect(new Date(expiryMs('2026-12-18')).toISOString()).toBe('2026-12-18T21:00:00.000Z'); // EST
    }
  });
});
