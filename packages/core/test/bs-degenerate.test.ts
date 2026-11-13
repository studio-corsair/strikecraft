import { describe, expect, it } from 'vitest';
import { impliedVol } from '../src/bs.ts';

describe('impliedVol on degenerate input', () => {
  it('exhausts its iteration budget and returns NaN when the underlying price is NaN', () => {
    // NaN spot slips past the no-arbitrage bound checks (comparisons with NaN are false), so the
    // solver can never converge; it must still terminate and hand back the non-number, not loop.
    expect(impliedVol(5, { S: NaN, K: 100, T: 0.5, r: 0.05, q: 0, right: 'C' })).toBeNaN();
  });
  it('still returns null for a missing price or expired option before touching the solver', () => {
    expect(impliedVol(0, { S: NaN, K: 100, T: 0.5, r: 0.05, q: 0, right: 'C' })).toBeNull();
    expect(impliedVol(5, { S: 100, K: 100, T: 0, r: 0.05, q: 0, right: 'C' })).toBeNull();
  });
});
