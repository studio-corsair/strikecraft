import { describe, expect, it } from 'vitest';
import {
  parseLeg,
  positionValue,
  probability,
  probTouch,
  probAbove,
  riskGrid,
  expiryMs,
  cost,
} from '../src/position.ts';
import { bsPrice } from '../src/bs.ts';
import { normCdf } from '../src/math.ts';

const now = Date.parse('2026-11-13T15:00:00Z');
const m = { S: 180, r: 0.04, q: 0, now };

describe('leg parsing', () => {
  it('parses options and stock', () => {
    expect(parseLeg('+100 C 185 2026-12-18 @4.71 iv=0.45')).toMatchObject({
      qty: 100,
      type: 'C',
      strike: 185,
      expiry: '2026-12-18',
      entry: 4.71,
      iv: 0.45,
      mult: 100,
    });
    expect(parseLeg('+100 S @180')).toMatchObject({ qty: 100, type: 'S', entry: 180, mult: 1 });
    expect(() => parseLeg('+1 X 100')).toThrow();
  });
  it('expiry is 16:00 New York time across DST', () => {
    expect(new Date(expiryMs('2026-12-18')).toISOString()).toBe('2026-12-18T21:00:00.000Z'); // EST
    expect(new Date(expiryMs('2026-07-17')).toISOString()).toBe('2026-07-17T20:00:00.000Z'); // EDT
  });
});

describe('closed-form probabilities', () => {
  it('touch = 2× expiring beyond when drift is zero (reflection principle)', () => {
    // nu = r - q - s²/2 = 0  ⇔  r = s²/2
    const s = 0.4,
      r = (s * s) / 2,
      T = 0.25,
      B = 200,
      S = 180;
    expect(probTouch(S, B, T, s, r, 0)).toBeCloseTo(2 * normCdf(-Math.log(B / S) / (s * Math.sqrt(T))), 12);
    expect(probTouch(S, 160, T, s, r, 0)).toBeCloseTo(2 * normCdf(Math.log(160 / S) / (s * Math.sqrt(T))), 12);
  });
  it('touch matches a Brownian-bridge Monte Carlo', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
    const S = 180,
      B = 205,
      T = 35 / 365,
      s = 0.5,
      r = 0.04,
      steps = 50,
      paths = 20000,
      dt = T / steps;
    const nu = r - (s * s) / 2;
    let hits = 0;
    for (let p = 0; p < paths; p++) {
      let x = Math.log(S),
        hit = false;
      for (let i = 0; i < steps && !hit; i++) {
        const y = x + nu * dt + s * Math.sqrt(dt) * gauss();
        // exact crossing probability between grid points (Brownian bridge)
        const b = Math.log(B);
        if (y >= b || rand() < Math.exp((-2 * (b - x) * (b - y)) / (s * s * dt))) hit = true;
        x = y;
      }
      if (hit) hits++;
    }
    expect(Math.abs(hits / paths - probTouch(S, B, T, s, r, 0))).toBeLessThan(0.012);
  });
  it('probAbove equals N(d2)', () => {
    const S = 180,
      K = 185,
      T = 0.1,
      s = 0.5,
      r = 0.04;
    const d2 = (Math.log(S / K) + (r - (s * s) / 2) * T) / (s * Math.sqrt(T));
    expect(probAbove(S, K, T, s, r)).toBeCloseTo(normCdf(d2), 12);
  });
});

describe('position valuation', () => {
  it('long call at expiry is intrinsic minus cost', () => {
    const legs = [parseLeg('+100 C 185 2026-12-18 @4.71 iv=0.45')];
    const v = positionValue(legs, m, { S: 200, at: expiryMs('2026-12-18') });
    expect(v.pnl).toBeCloseTo(100 * 100 * (15 - 4.71), 6);
    expect(cost(legs)).toBeCloseTo(47100, 6);
  });
  it('T+0 value equals BS price × contracts × 100', () => {
    const legs = [parseLeg('+100 C 185 2026-12-18 @4.71 iv=0.45')];
    const T = (expiryMs('2026-12-18') - now) / (365 * 864e5);
    expect(positionValue(legs, m).value).toBeCloseTo(
      10000 * bsPrice({ S: 180, K: 185, T, r: 0.04, q: 0, sigma: 0.45, right: 'C' }),
      6,
    );
  });
  it('calendar keeps back-month time value at front expiry', () => {
    const legs = [parseLeg('-1 C 185 2026-11-20 @3 iv=0.5'), parseLeg('+1 C 185 2026-12-18 @6 iv=0.45')];
    const v = positionValue(legs, m, { S: 185, at: expiryMs('2026-11-20') });
    expect(v.value).toBeGreaterThan(0); // short expired worthless ATM, long still has time value
    expect(v.value).toBeLessThan(1000);
  });
});

describe('probability analysis', () => {
  it('long call: one breakeven at K + premium, unlimited profit, max loss = debit, POP = P(S_T > BE)', () => {
    const legs = [parseLeg('+1 C 185 2026-12-18 @4.71 iv=0.45')];
    const p = probability(legs, m, { sigma: 0.45 });
    expect(p.breakevens).toHaveLength(1);
    expect(p.breakevens[0]).toBeCloseTo(189.71, 1);
    expect(p.maxProfit).toBe('unlimited');
    expect(p.maxLoss).toBeCloseTo(-471, 1);
    const t = (expiryMs('2026-12-18') - now) / (365 * 864e5);
    expect(p.probabilityOfProfit).toBeCloseTo(probAbove(180, 189.71 + 0.00005, t, 0.45, 0.04), 2);
  });
  it('EV of a fairly priced option is ~ zero under the risk-neutral measure (forward value)', () => {
    const T = (expiryMs('2026-12-18') - now) / (365 * 864e5);
    const fair = bsPrice({ S: 180, K: 185, T, r: 0.04, q: 0, sigma: 0.45, right: 'C' });
    const p = probability([parseLeg(`+1 C 185 2026-12-18 @${fair} iv=0.45`)], m, { sigma: 0.45 });
    // undiscounted expectation of payoff = fair × e^{rT}; EV = that − fair
    expect(p.expectedValue).toBeCloseTo(100 * fair * (Math.exp(0.04 * T) - 1), 0);
  });
  it('iron condor: two breakevens, bounded both ways', () => {
    const e = '2026-12-18';
    const legs = [
      `+1 P 150 ${e} @1 iv=.5`,
      `-1 P 160 ${e} @2.5 iv=.48`,
      `-1 C 200 ${e} @2.6 iv=.44`,
      `+1 C 210 ${e} @1.2 iv=.43`,
    ].map(parseLeg);
    const p = probability(legs, m, { sigma: 0.45 });
    const credit = 2.5 + 2.6 - 1 - 1.2;
    expect(p.breakevens.map((x) => +x!.toFixed(2))).toEqual([+(160 - credit).toFixed(2), +(200 + credit).toFixed(2)]);
    expect(p.maxProfit).toBeCloseTo(100 * credit, 1);
    expect(p.maxLoss).toBeCloseTo(-100 * (10 - credit), 1);
  });
  it('naked short call reports unlimited loss', () => {
    expect(probability([parseLeg('-1 C 200 2026-12-18 @3 iv=.45')], m).maxLoss).toBe('unlimited');
  });
});

describe('risk grid', () => {
  it('returns rows per date × IV shift with P&L numbers', () => {
    const g = riskGrid([parseLeg('+100 C 185 2026-12-18 @4.71 iv=0.45')], m, { ivShifts: [-0.1, 0, 0.1], steps: 11 });
    expect(g.prices).toHaveLength(11);
    expect(g.rows).toHaveLength(15);
    const now0 = g.rows.find((r) => r.ivShift === 0 && r.date.startsWith('now'))!;
    const up = g.rows.find((r) => r.ivShift === 0.1 && r.date.startsWith('now'))!;
    expect(up.pnl[5]!).toBeGreaterThan(now0.pnl[5]!); // long vega
  });
});

describe('from-now metrics', () => {
  it('a winning position reports EV and POP from today’s mark, not just vs entry', () => {
    const legs = [parseLeg('+1 C 185 2026-12-18 @1 iv=0.45')]; // bought cheap, now worth more
    const p = probability(legs, m, { sigma: 0.45 });
    expect(p.unrealizedPnlNow!).toBeGreaterThan(0);
    expect(p.expectedValueFromNow!).toBeCloseTo(p.expectedValue! - p.unrealizedPnlNow!, 1);
    expect(p.probProfitFromNow!).toBeLessThan(p.probabilityOfProfit!);
  });
});
