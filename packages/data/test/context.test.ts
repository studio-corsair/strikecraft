/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over dynamic JSON results */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, NOW, SYM, S0, R, type FakeOpts } from './fixtures/fake-market.ts';
import { parseLeg } from '@strikebench/core';

const h = vi.hoisted(() => ({ impl: null as null | ((u: string, i?: any) => Promise<any>) }));
vi.mock('../src/yahoo/http.ts', () => ({ httpFetch: (u: string, i?: any) => h.impl!(u, i) }));

async function load(o: FakeOpts = {}) {
  h.impl = fakeFetch(o).fn;
  vi.resetModules();
  return import('../src/yahoo/context.ts');
}
const item = (out: any, name: string) => out.items.find((i: any) => i.input === name);

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
afterEach(() => vi.useRealTimers());

describe('context without a position', () => {
  it('pairs each market input with its meaning', async () => {
    const { context } = await load();
    const out = await context(SYM);
    expect(out.market).toEqual({
      symbol: SYM,
      price: S0,
      session: 'regular',
      regularClose: S0,
      asOf: new Date(NOW).toISOString(),
    });
    expect(out.position).toBeNull();
    expect(out.positionBias).toBeNull();
    expect(out.items).toHaveLength(11);

    const tgt = item(out, 'Analyst price target');
    expect(tgt.value).toEqual({ mean: 120, high: 150, low: 90, analysts: 40, recommendation: 'buy', upsidePct: 20 });
    expect(tgt.meaning).toBe(
      'Consensus target is 20.0% above spot. Targets lag price and rarely bind short-dated options; useful only as a sentiment anchor.',
    );
    expect(item(out, 'Rating distribution (current month)').value).toEqual({
      strongBuy: 10,
      buy: 20,
      hold: 5,
      sell: 1,
      strongSell: 0,
    });
    expect(item(out, 'Earnings estimates & revisions').value).toEqual([
      {
        period: '0q',
        endDate: '2026-06-30',
        epsAvg: 1.5,
        epsGrowth: 0.1,
        revenueAvg: 5e9,
        revisionsUp30d: 5,
        revisionsDown30d: 1,
      },
    ]);
    const si = item(out, 'Short interest');
    expect(si.value).toEqual({
      shortPctFloat: 0.15,
      sharesShort: 1_000_000,
      shortRatioDays: 2.5,
      dateShortInterest: '2026-05-15',
    });
    expect(si.meaning).toMatch(/^High short interest/);
    const div = item(out, 'Dividends');
    expect(div.value).toMatchObject({ yield: 0.01, rate: 1, exDividendDate: '2026-06-15' });
    expect(div.meaning).toMatch(/^Dividend matters/);
    expect(item(out, 'Beta / valuation').value).toEqual({ beta: 1.3, trailingPE: 30, forwardPE: 25, marketCap: 1e12 });

    const vix = item(out, 'VIX (S&P 30-day implied vol)');
    expect(vix.value).toEqual({ last: 30, median1y: 20, percentile1y: 0.996 });
    expect(vix.meaning).toMatch(/^Market-wide fear is elevated/);
    const ts = item(out, 'VIX term structure (VIX / VIX3M)');
    expect(ts.value).toBe(1.2);
    expect(ts.meaning).toMatch(/^Backwardation/);
    expect(item(out, 'VXN (Nasdaq-100 implied vol)').value).toEqual({ last: 22, median1y: 22 });
    expect(item(out, 'VVIX (vol of VIX)').meaning).toMatch(/^Vol itself is unstable/);
    const rf = item(out, 'Risk-free rate');
    expect(rf.value).toEqual({ r: R, source: '^IRX 13-week T-bill' });
    expect(rf.meaning).toBe(
      'Carry: each 1% in rates moves this position by its rho; material only for long-dated options.',
    );
  });

  it('small trailing yield → dividend called small', async () => {
    const { context } = await load({ noDividend: true });
    const out = await context(SYM);
    expect(item(out, 'Dividends').meaning).toMatch(/^Dividend is small/);
  });
});

describe('context with a position', () => {
  it('fills legs, attaches the position block, and tailors the meanings to its bias', async () => {
    const { context } = await load();
    const out = await context(SYM, [parseLeg('+1 C 100 2026-06-19')]);
    expect(out.positionBias).toEqual({ longDelta: true, longVega: true });
    expect(out.position!.legs[0]!.iv).toBeCloseTo(0.55, 3);
    expect(item(out, 'Analyst price target').meaning).toContain('(supports a long-delta thesis if far above spot)');
    expect(item(out, 'Risk-free rate').meaning).toContain(`(${out.position!.greeks.rhoPer1Pct} $/1%)`);
  });
  it('short-delta position gets the headwind wording', async () => {
    const { context } = await load();
    const out = await context(SYM, [parseLeg('-1 C 100 2026-06-19 @6 iv=0.5')]);
    expect(out.positionBias).toEqual({ longDelta: false, longVega: false });
    expect(item(out, 'Analyst price target').meaning).toContain(
      '(headwind for a short-delta thesis if far above spot)',
    );
  });
});
