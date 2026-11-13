/* eslint-disable @typescript-eslint/no-explicit-any -- the fake fetch takes loosely typed init */
// The Yahoo rung must always say it is Yahoo, delayed 15 minutes, and when its numbers are from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, NOW, SYM, S0, EXPIRIES, STRIKES } from './fixtures/fake-market.ts';
import { parseLeg } from '@strikecraft/core';

const h = vi.hoisted(() => ({ impl: null as null | ((u: string, i?: any) => Promise<any>) }));
vi.mock('../src/yahoo/http.ts', () => ({ httpFetch: (u: string, i?: any) => h.impl!(u, i) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  h.impl = fakeFetch().fn;
  vi.resetModules();
});
afterEach(() => vi.useRealTimers());

describe('Yahoo market-data source', () => {
  it('tags the quote with source yahoo, 15 minutes delayed, as of the last print', async () => {
    const { yahooSource } = await import('../src/yahoo/source.ts');
    const q = await yahooSource().quote(SYM);
    expect(q).toMatchObject({
      symbol: SYM,
      lastPrice: S0,
      source: 'yahoo',
      sourceLabel: 'Yahoo',
      delayed: true,
      delayMinutes: 15,
    });
    expect(q.asOf).toBe(q.lastTime * 1000);
    expect(q.asOf).toBeLessThanOrEqual(NOW);
  });

  it('tags expirations and chain slices, with rows for every strike', async () => {
    const { yahooSource } = await import('../src/yahoo/source.ts');
    const src = yahooSource();
    const e = await src.expirations(SYM);
    expect(e).toMatchObject({ symbol: SYM, expirations: EXPIRIES, source: 'yahoo', delayed: true, asOf: NOW });
    const c = await src.optionChain(SYM, EXPIRIES[0]!);
    expect(c).toMatchObject({ expiry: EXPIRIES[0], source: 'yahoo', delayMinutes: 15, asOf: NOW });
    expect(c.calls.map((r) => r.strike)).toEqual(STRIKES);
    expect(c.puts.length).toBe(STRIKES.length);
  });

  it('carries the Yahoo tag through the engine into an analysis result', async () => {
    const live = await import('../src/yahoo/live.ts');
    const out = await live.analyze(SYM, [parseLeg(`+1 C 100 ${EXPIRIES[1]}`)]);
    expect(out.sources.quote).toMatchObject({ source: 'yahoo', delayed: true, delayMinutes: 15 });
    expect(out.sources.chains.map((t) => t.source)).toEqual(['yahoo']);
    expect(out.sources.chain).toMatchObject({ source: 'yahoo', sourceLabel: 'Yahoo' });
  });
});
