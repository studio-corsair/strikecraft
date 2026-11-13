// Edge branches of the pure math modules: expiry/zero-vol pricing, event-variance corner cases,
// leg parsing / valuation errors, explicit risk-grid dates, quantiles, rolling RV, reactions.
import { describe, expect, it } from 'vitest';
import { bsPrice, bsGreeks, impliedVol } from '../src/bs.ts';
import { constantMaturityIv, eventVariance } from '../src/chain.ts';
import { parseLeg, legValue, riskGrid, priceQuantile, expiryMs } from '../src/position.ts';
import { rollingRealized, realizedVol, earningsReactions } from '../src/vol.ts';

describe('bsPrice / bsGreeks at expiry or zero vol', () => {
  it('T=0 → intrinsic', () => {
    expect(bsPrice({ S: 110, K: 100, T: 0, r: 0.05, q: 0, sigma: 0.3, right: 'C' })).toBe(10);
    expect(bsPrice({ S: 110, K: 100, T: 0, r: 0.05, q: 0, sigma: 0.3, right: 'P' })).toBe(0);
  });
  it('sigma=0 → discounted forward intrinsic', () => {
    const p = bsPrice({ S: 100, K: 95, T: 1, r: 0.05, q: 0.01, sigma: 0, right: 'C' });
    expect(p).toBeCloseTo(Math.exp(-0.05) * (100 * Math.exp(0.04) - 95), 10);
  });
  it('expired greeks: ITM call delta 1, ITM put delta −1, OTM 0, no gamma/theta', () => {
    const base = { K: 100, T: 0, r: 0.05, q: 0, sigma: 0.3 };
    const c = bsGreeks({ ...base, S: 120, right: 'C' });
    expect(c).toMatchObject({ price: 20, delta: 1, gamma: 0, theta: 0 });
    expect(bsGreeks({ ...base, S: 80, right: 'P' }).delta).toBe(-1);
    expect(bsGreeks({ ...base, S: 80, right: 'C' }).delta).toBe(0);
  });
  it('impliedVol rejects non-positive price and price above the no-arb ceiling', () => {
    const p = { S: 100, K: 100, T: 0.5, r: 0.03, q: 0, right: 'C' as const };
    expect(impliedVol(0, p)).toBeNull();
    expect(impliedVol(100, p)).toBeNull();
  });
});

describe('constantMaturityIv edge', () => {
  it('returns null for a non-numeric target tenor (interp falls through)', () => {
    const term = [
      { T: 0.1, iv: 0.3 },
      { T: 0.3, iv: 0.35 },
    ];
    expect(constantMaturityIv(term, NaN)).toBeNull();
    expect(constantMaturityIv(term, 73)).toBeCloseTo(Math.sqrt((0.3 ** 2 * 0.1 + 0.35 ** 2 * 0.3) / 2 / 0.2), 10);
  });
});

describe('eventVariance corner cases', () => {
  it('pre-event IV above the post-event IV → no event premium', () => {
    const r = eventVariance(
      [
        { expiry: '2026-06-05', T: 5 / 365, iv: 0.6 },
        { expiry: '2026-06-19', T: 19 / 365, iv: 0.4 },
      ],
      '2026-06-10',
      'AMC',
    );
    expect(r).toEqual({
      method: 'ex-event vol = IV of pre-event expiry 2026-06-05',
      eventMoveStd: null,
      note: 'front post-event IV does not exceed ex-event vol — no event premium priced',
    });
  });
  it('a single post-event expiry and no pre-event one → insufficient expiries', () => {
    expect(eventVariance([{ expiry: '2026-06-19', T: 19 / 365, iv: 0.5 }], '2026-06-10')).toEqual({
      method: 'insufficient expiries',
      eventMoveStd: null,
    });
  });
  it('no post-event expiry → null', () => {
    expect(eventVariance([{ expiry: '2026-06-05', T: 5 / 365, iv: 0.5 }], '2026-06-10')).toBeNull();
  });
});

describe('position edges', () => {
  it('parseLeg rejects an option leg with a bad expiry or strike', () => {
    expect(() => parseLeg('+1 C 100 2026/12/18')).toThrow('bad option leg "+1 C 100 2026/12/18"');
    expect(() => parseLeg('+1 P abc 2026-12-18')).toThrow('bad option leg');
  });
  it('stock leg value = qty × S with delta = qty', () => {
    const v = legValue(parseLeg('-50 S @100'), { S: 120, r: 0.05, q: 0, now: Date.now() });
    expect(v).toEqual({
      value: -6000,
      delta: -50,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
      vanna: 0,
      charm: 0,
      vomma: 0,
      price: 120,
    });
  });
  it('option leg without IV throws a helpful error', () => {
    expect(() => legValue(parseLeg('+1 C 100 2099-01-16 @5'), { S: 100, r: 0.05, q: 0, now: Date.now() })).toThrow(
      'leg C 100 2099-01-16 has no IV',
    );
  });
  it('riskGrid honours explicit dates (now / expiry / calendar date capped at horizon)', () => {
    const now = Date.UTC(2026, 5, 1, 15);
    const m = { S: 100, r: 0.05, q: 0, now };
    const legs = [parseLeg('+1 C 100 2026-06-19 @3 iv=0.4')];
    const g = riskGrid(legs, m, { prices: [100, 110], dates: ['now', '2026-06-10', '2026-12-18', 'expiry'] });
    expect(g.rows.map((r) => r.date)).toEqual(['now', '2026-06-10', '2026-12-18', 'expiry']);
    const [nowRow, mid, past, exp] = g.rows.map((r) => r.pnl);
    // at expiry: intrinsic − entry → (0 − 3)·100 and (10 − 3)·100
    expect(exp).toEqual([-300, 700]);
    // a date past the first expiry is capped at the horizon
    expect(past).toEqual(exp);
    const at = (t: number) => legValue(legs[0]!, m, { S: 100, at: t }).value - 300;
    expect(nowRow![0]).toBeCloseTo(at(now), 2);
    expect(mid![0]).toBeCloseTo(at(expiryMs('2026-06-10') - 1), 2);
    expect(nowRow![0]).toBeGreaterThan(mid![0]!); // time decay
  });
  it('priceQuantile: median under zero drift is S·exp(−σ²t/2)', () => {
    expect(priceQuantile(100, 1, 0.2, 0.5)).toBeCloseTo(100 * Math.exp(-0.02), 8);
    expect(priceQuantile(100, 1, 0.2, 0.84, 0.02)).toBeGreaterThan(priceQuantile(100, 1, 0.2, 0.5, 0.02));
  });
});

describe('vol edges', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    t: i,
    open: 100,
    high: 101,
    low: 99,
    close: 100 * (1 + 0.01 * Math.sin(i)),
    volume: 1,
  }));
  it('rollingRealized: null until n returns exist, then the trailing realized vol', () => {
    const rr = rollingRealized(bars, 20);
    expect(rr).toHaveLength(30);
    expect(rr.slice(0, 20).every((x) => x.rv === null)).toBe(true);
    expect(rr[25]).toEqual({
      date: '2026-01-26',
      rv: realizedVol(
        bars.slice(0, 26).map((b) => b.close),
        20,
      ),
    });
  });
  it('earningsReactions: an event on a non-trading day uses the next bar; past the data it is skipped', () => {
    const b = [
      { date: '2026-01-02', t: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { date: '2026-01-05', t: 1, open: 104, high: 110, low: 100, close: 110, volume: 1 },
    ];
    const rx = earningsReactions(
      [
        { date: '2026-01-03', timing: 'BMO' }, // Saturday → bar 2026-01-05, move vs 2026-01-02
        { date: '2026-02-01', timing: 'BMO' }, // after the last bar
      ],
      b,
    );
    expect(rx).toEqual([
      { date: '2026-01-03', timing: 'BMO', closeBefore: 100, closeAfter: 110, movePct: 10, gapPct: 4 },
    ]);
  });
});
