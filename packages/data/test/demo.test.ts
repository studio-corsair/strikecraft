import { describe, it, expect } from 'vitest';
import { bsPrice, parseLeg, expiryMs } from '@strikebench/core';
import { demoSource, simulateSnapshot, defaultDemoSnapshots, listedExpiries, prng, DEMO_AS_OF } from '../src/demo.ts';
import type { DemoSnapshot } from '../src/demo.ts';
import { createEngine } from '../src/engine.ts';
import { createLadder } from '../src/ladder.ts';

// A snapshot exactly as the daily chain logger writes it (yahoo/logger.ts): no `demo` block.
const RECORDED: DemoSnapshot = {
  symbol: 'TEST',
  loggedAt: '2026-06-01T18:00:00.000Z',
  tradingDay: '2026-06-01',
  session: 'regular',
  S: 100,
  Smarks: 100,
  r: 0.04,
  q: 0,
  chains: [
    {
      expiry: '2026-07-17',
      T: 0.126,
      contracts: [95, 100, 105].flatMap((k) =>
        (['C', 'P'] as const).map((r) => {
          const T = (expiryMs('2026-07-17') - Date.parse('2026-06-01T18:00:00.000Z')) / (365 * 864e5);
          const mid = bsPrice({ S: 100, K: k, T, r: 0.04, q: 0, sigma: 0.3, right: r });
          return {
            k,
            r,
            b: +(mid - 0.02).toFixed(2),
            a: +(mid + 0.02).toFixed(2),
            l: +mid.toFixed(2),
            v: 10,
            oi: 100,
            m: mid,
            ms: 'mid',
            iv: 0.3,
            yiv: 0.31,
            d: 0.5,
          };
        }),
      ),
    },
  ],
};

describe('demo source on a recorded chain-logger snapshot', () => {
  const src = demoSource([RECORDED]);

  it('serves quote, expirations and chain from the snapshot, each tagged as recorded demo data', async () => {
    const q = await src.quote('test');
    expect(q).toMatchObject({
      symbol: 'TEST',
      lastPrice: 100,
      regularPrice: 100,
      session: 'regular',
      source: 'demo',
      sourceLabel: 'Recorded demo data',
      delayed: true,
    });
    expect(q.asOf).toBe(Date.parse(RECORDED.loggedAt));
    expect(src.asOf).toBe(Date.parse(RECORDED.loggedAt));
    expect(src.simulated).toBe(false);
    expect((await src.expirations('TEST')).expirations).toEqual(['2026-07-17']);
    const c = await src.optionChain('TEST', '2026-07-17');
    expect(c.source).toBe('demo');
    expect(c.calls.map((r) => r.strike)).toEqual([95, 100, 105]);
    expect(c.calls[1]).toMatchObject({
      contractSymbol: 'TEST260717C00100000',
      impliedVolatility: 0.31,
      openInterest: 100,
    });
  });

  it('says what is missing instead of inventing it', async () => {
    await expect(src.quote('NOPE')).rejects.toThrow('NOPE is not in the demo data (have TEST)');
    await expect(src.optionChain('TEST', '2026-08-21')).rejects.toThrow('no expiry 2026-08-21; have 2026-07-17');
    await expect(src.daily('TEST')).rejects.toThrow('the TEST snapshot has no daily bars recorded');
    expect(await src.earningsInfo('TEST')).toEqual({ next: null, callTime: null, epsSurprises: [] });
    expect(() => demoSource([])).toThrow('demo mode needs at least one snapshot');
  });

  it('drives the engine: IV is recovered from the recorded marks and every result names its source', async () => {
    const engine = createEngine(createLadder([src]), { now: () => src.asOf });
    const out = await engine.analyze('TEST', [parseLeg('+1 C 100 2026-07-17')]);
    expect(out.position.legs[0]!.iv).toBeCloseTo(0.3, 2);
    expect(out.sources.quote).toMatchObject({ source: 'demo', delayed: true });
    expect(out.sources.chain).toMatchObject({ source: 'demo', sourceLabel: 'Recorded demo data' });
    expect(JSON.parse(JSON.stringify(out)).sources.chain.source).toBe('demo'); // survives serialization
  });
});

describe('simulated demo market', () => {
  it('is deterministic for a seed', () => {
    const a = simulateSnapshot({ symbol: 'X', S: 100, prevClose: 99, asOf: DEMO_AS_OF, baseIv: 0.4, seed: 3 });
    const b = simulateSnapshot({ symbol: 'X', S: 100, prevClose: 99, asOf: DEMO_AS_OF, baseIv: 0.4, seed: 3 });
    const c = simulateSnapshot({ symbol: 'X', S: 100, prevClose: 99, asOf: DEMO_AS_OF, baseIv: 0.4, seed: 4 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    const r = prng(1);
    expect([r.next(), r.next()].every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('lists the next 8 Fridays plus monthly third Fridays, all in the future', () => {
    const asOf = Date.parse(DEMO_AS_OF);
    const ex = listedExpiries(asOf);
    expect(ex.slice(0, 3)).toEqual(['2026-11-20', '2026-11-27', '2026-12-04']);
    expect(ex).toContain('2026-12-18'); // third Friday of December
    expect(ex.every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5 && expiryMs(d) > asOf)).toBe(true);
    expect([...ex].sort()).toEqual(ex);
  });

  it('has sane two-sided quotes, and history that ends at the previous close', () => {
    const s = simulateSnapshot({
      symbol: 'X',
      S: 100,
      prevClose: 98.5,
      asOf: DEMO_AS_OF,
      baseIv: 0.4,
      earnings: { date: '2026-12-02', eventStd: 0.07 },
    });
    expect(s.session).toBe('regular');
    for (const ch of s.chains)
      for (const c of ch.contracts) {
        expect(c.a).toBeGreaterThan(c.b);
        expect(c.b).toBeGreaterThanOrEqual(0);
        expect(c.v).toBeGreaterThanOrEqual(0);
      }
    const bars = s.demo!.bars!;
    expect(bars.length).toBe(5 * 252);
    expect(bars[bars.length - 1]!.close).toBe(98.5);
    expect(
      bars.every((b) => b.high >= Math.max(b.open, b.close) - 0.011 && b.low <= Math.min(b.open, b.close) + 0.011),
    ).toBe(true);
    expect(s.demo!.earnings!.dates.length).toBe(20);
    expect(s.demo!.earnings!.info.next).toBe('2026-12-02');
  });

  it('prices an earnings bump the engine can find again', async () => {
    const src = demoSource(defaultDemoSnapshots());
    expect(src.symbols).toEqual(['NVDA', 'SPY', 'AAPL', 'TSLA']);
    expect(src.simulated).toBe(true);
    const engine = createEngine(createLadder([src]), { now: () => src.asOf });
    const e = await engine.earnings('NVDA', [parseLeg('+1 C 185 2026-12-18')]);
    expect(e.nextEarnings).toMatchObject({ date: '2026-11-17', timing: 'AMC' });
    // The generator priced an 8.5% one-sigma event; the term-structure decomposition recovers it.
    expect(e.implied.impliedEventMove1SigmaPct).toBeGreaterThan(7);
    expect(e.implied.impliedEventMove1SigmaPct).toBeLessThan(10);
    expect(e.historicalReactions.stats.quarters).toBe(20);
    expect(e.positionThroughEvent.grid.length).toBe(9);
    expect(e.sources.quote).toMatchObject({ source: 'demo', sourceLabel: 'Simulated demo data' });
    const a = await engine.analyze('SPY', [parseLeg('-1 P 660 2026-12-18'), parseLeg('+1 P 650 2026-12-18')]);
    expect(a.probability.probabilityOfProfit).toBeGreaterThan(0.5); // a short put spread below spot
    const v = await engine.vol('TSLA');
    expect(v.atmIv30dConstantMaturity).toBeGreaterThan(0.4);
  });
});
