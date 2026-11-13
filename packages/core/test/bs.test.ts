import { describe, expect, it } from 'vitest';
import { bsPrice, bsGreeks, impliedVol, crrPrice, priceAndGreeks, priceBounds } from '../src/bs.ts';
import { normCdf, normInv } from '../src/math.ts';

describe('normal distribution', () => {
  it('matches tabulated values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 14);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normCdf(-3)).toBeCloseTo(0.0013498980316301, 12);
  });
  it('inverse round-trips', () => {
    for (const p of [1e-6, 0.01, 0.25, 0.5, 0.9, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 10);
  });
});

describe('Black-Scholes textbook values', () => {
  it('Hull ex. 15.6: S=42 K=40 r=10% vol=20% T=0.5 → call 4.76, put 0.81', () => {
    const p = { S: 42, K: 40, r: 0.1, q: 0, sigma: 0.2, T: 0.5 };
    expect(bsPrice({ ...p, right: 'C' })).toBeCloseTo(4.7594, 3);
    expect(bsPrice({ ...p, right: 'P' })).toBeCloseTo(0.8086, 3);
  });
  it('Haug p.4: Merton put S=100 K=95 T=0.5 r=10% q=5% vol=20% → 2.4648', () => {
    expect(bsPrice({ S: 100, K: 95, T: 0.5, r: 0.1, q: 0.05, sigma: 0.2, right: 'P' })).toBeCloseTo(2.4648, 4);
  });
  it('Hull ch.19 greeks: S=49 K=50 r=5% vol=20% T=20wk', () => {
    const g = bsGreeks({ S: 49, K: 50, r: 0.05, q: 0, sigma: 0.2, T: 0.3846, right: 'C' });
    expect(g.price).toBeCloseTo(2.4, 1);
    expect(g.delta).toBeCloseTo(0.522, 3);
    expect(g.gamma).toBeCloseTo(0.066, 3);
    expect(g.raw!.theta).toBeCloseTo(-4.31, 2); // per year
    expect(g.raw!.vega).toBeCloseTo(12.1, 1); // per 1.00 vol
    expect(g.raw!.rho).toBeCloseTo(8.91, 2);
    expect(g.theta).toBeCloseTo(-4.31 / 365, 4); // trader units: per calendar day
    expect(g.vega).toBeCloseTo(0.121, 3); // per vol point
  });
  it('put-call parity with dividends', () => {
    const p = { S: 180, K: 185, T: 0.1, r: 0.04, q: 0.01, sigma: 0.5 };
    const c = bsPrice({ ...p, right: 'C' }),
      put = bsPrice({ ...p, right: 'P' });
    expect(c - put).toBeCloseTo(p.S * Math.exp(-p.q * p.T) - p.K * Math.exp(-p.r * p.T), 10);
  });
});

describe('higher-order greeks agree with finite differences', () => {
  const base = { S: 180, K: 185, T: 35 / 365, r: 0.04, q: 0.005, sigma: 0.48 };
  for (const right of ['C', 'P'] as const) {
    it(`vanna / charm / vomma / speed (${right})`, () => {
      const p = { ...base, right };
      const g = bsGreeks(p);
      const h = 1e-4;
      const dSig =
        (bsGreeks({ ...p, sigma: p.sigma + h }).delta - bsGreeks({ ...p, sigma: p.sigma - h }).delta) / (2 * h);
      expect(g.raw!.vanna).toBeCloseTo(dSig, 5);
      const dT = (bsGreeks({ ...p, T: p.T - h }).delta - bsGreeks({ ...p, T: p.T + h }).delta) / (2 * h);
      expect(g.raw!.charm).toBeCloseTo(dT, 4);
      const dV =
        (bsGreeks({ ...p, sigma: p.sigma + h }).raw!.vega - bsGreeks({ ...p, sigma: p.sigma - h }).raw!.vega) / (2 * h);
      expect(g.raw!.vomma).toBeCloseTo(dV, 3);
      const hS = 1e-3;
      const dG = (bsGreeks({ ...p, S: p.S + hS }).gamma - bsGreeks({ ...p, S: p.S - hS }).gamma) / (2 * hS);
      expect(g.speed).toBeCloseTo(dG, 7);
    });
  }
});

describe('implied volatility', () => {
  it('round-trips across moneyness and tenor', () => {
    for (const K of [120, 170, 185, 250])
      for (const T of [2 / 365, 0.1, 1.5])
        for (const right of ['C', 'P'] as const) {
          const p = { S: 180, K, T, r: 0.04, q: 0, right };
          const px = bsPrice({ ...p, sigma: 0.55 });
          if (px - priceBounds(p).lo < 1e-6) continue; // no time value left: vol is not identifiable
          expect(impliedVol(px, p)).toBeCloseTo(0.55, 6);
        }
  });
  it('returns null below intrinsic (stale print) instead of a fake vol', () => {
    expect(impliedVol(10, { S: 200, K: 185, T: 0.1, r: 0.04, q: 0, right: 'C' })).toBeNull();
  });
});

describe('American (CRR)', () => {
  it('Hull: American put S=50 K=50 r=10% vol=40% T=5/12 ≈ 4.28', () => {
    expect(crrPrice({ S: 50, K: 50, r: 0.1, q: 0, sigma: 0.4, T: 5 / 12, right: 'P', steps: 1000 })).toBeCloseTo(
      4.28,
      1,
    );
  });
  it('European CRR converges to BS', () => {
    const p = { S: 42, K: 40, r: 0.1, q: 0, sigma: 0.2, T: 0.5, right: 'C' as const };
    expect(crrPrice({ ...p, american: false, steps: 2000 })).toBeCloseTo(bsPrice(p), 2);
  });
  it('no-dividend American call equals European', () => {
    const p = { S: 180, K: 185, r: 0.04, q: 0, sigma: 0.5, T: 0.1, right: 'C' as const };
    expect(priceAndGreeks(p, 'american').price).toBeCloseTo(bsPrice(p), 2);
  });
});
