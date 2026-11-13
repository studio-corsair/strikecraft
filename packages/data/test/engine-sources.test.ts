// Regression tests for the phase-2 review findings: a result must name exactly the sources it
// used, the chain cache must expire, and the ladder cooldown must not leak across symbols.
import { describe, it, expect } from 'vitest';
import { parseLeg, expiryMs } from '@strikecraft/core';
import { createEngine } from '../src/engine.ts';
import { createLadder } from '../src/ladder.ts';
import { demoSource, simulateSnapshot, DEMO_AS_OF } from '../src/demo.ts';
import { sessionAt } from '../src/symbols.ts';
import { tag } from '../src/types.ts';
import type { MarketDataSource, SourceInfo } from '../src/types.ts';

const snap = () => simulateSnapshot({ symbol: 'X', S: 100, prevClose: 99, asOf: DEMO_AS_OF, baseIv: 0.4, seed: 5 });
const BROKER: SourceInfo = { id: 'tradier', label: 'Tradier', delayMinutes: 0 };

describe('engine source reporting', () => {
  it('lists every chain source a result used and labels the result by the least fresh one', async () => {
    const demo = demoSource([snap()]);
    const [near, far] = (await demo.expirations('X')).expirations;
    // A real-time broker that only carries the far expiry: the near one falls through to the demo rung.
    const broker: MarketDataSource = {
      ...BROKER,
      async optionChain(sym, expiry) {
        if (expiry !== far) throw new Error(`no chain for ${expiry}`);
        return { ...(await demo.optionChain(sym, expiry)), ...tag(BROKER, demo.asOf) };
      },
    };
    const engine = createEngine(createLadder([broker, demo]), { now: () => demo.asOf });
    const atm = (expiry: string) => parseLeg(`+1 C 100 ${expiry}`);

    const mixed = await engine.analyze('X', [atm(near!), atm(far!)]);
    expect(mixed.sources.chains.map((t) => t.source).sort()).toEqual(['demo', 'tradier']);
    expect(mixed.sources.chain).toMatchObject({ source: 'demo', delayed: true }); // the delayed one wins the label

    // A later call that touches only the broker-served expiry must not inherit the demo tag.
    const brokerOnly = await engine.analyze('X', [atm(far!)]);
    expect(brokerOnly.sources.chains.map((t) => t.source)).toEqual(['tradier']);
    expect(brokerOnly.sources.chain).toMatchObject({ source: 'tradier', delayed: false });
    // ...and the earlier result still reports what it used.
    expect(mixed.sources.chains.length).toBe(2);
  });

  it('refetches a chain once its cache entry is older than the TTL, and not before', async () => {
    const demo = demoSource([snap()]);
    let fetches = 0;
    const counting: MarketDataSource = {
      ...demo,
      optionChain: (s, e) => {
        fetches++;
        return demo.optionChain(s, e);
      },
    };
    let now = demo.asOf;
    const engine = createEngine(createLadder([counting]), { now: () => now, chainTtlMs: 20_000 });
    const expiry = (await demo.expirations('X')).expirations[2]!;
    const ms = await engine.marketState('X');
    await engine.expiryChain(ms, expiry);
    now += 19_000;
    await engine.expiryChain(ms, expiry);
    expect(fetches).toBe(1);
    now += 2_000; // 21 s after the fetch
    await engine.expiryChain(ms, expiry);
    expect(fetches).toBe(2);
  });
});

describe('ladder cooldown scope', () => {
  it('a rung that rejects one symbol keeps first place for the others', async () => {
    const demo = demoSource([snap()]);
    const calls: string[] = [];
    const broker: MarketDataSource = {
      ...BROKER,
      async quote(sym) {
        calls.push(sym);
        if (sym === 'ZZZZ') throw new Error('unknown symbol');
        return { ...(await demo.quote('X')), symbol: sym, ...tag(BROKER, demo.asOf) };
      },
    };
    const fallback: MarketDataSource = { ...demo, quote: async (sym) => ({ ...(await demo.quote('X')), symbol: sym }) };
    const ladder = createLadder([broker, fallback], { now: () => 0 });
    expect((await ladder.quote('ZZZZ')).source).toBe('demo'); // broker rejected it
    expect((await ladder.quote('X')).source).toBe('tradier'); // still asked first for another symbol
    expect(calls).toEqual(['ZZZZ', 'X']);
  });

  it('shows a demo rung as delayed, never live', async () => {
    const ladder = createLadder([demoSource([snap()])]);
    await ladder.quote('X');
    expect(ladder.status()[0]).toMatchObject({ id: 'demo', state: 'delayed' });
  });
});

describe('session clock', () => {
  it('knows pre-market, regular, post-market, overnight and weekends in New York time', () => {
    expect(sessionAt(Date.parse('2026-11-13T19:30:00Z'))).toBe('regular'); // Fri 14:30 EST
    expect(sessionAt(Date.parse('2026-11-13T12:00:00Z'))).toBe('pre'); // Fri 07:00 EST
    expect(sessionAt(Date.parse('2026-11-13T22:00:00Z'))).toBe('post'); // Fri 17:00 EST
    expect(sessionAt(Date.parse('2026-11-13T07:00:00Z'))).toBe('closed'); // Fri 02:00 EST
    expect(sessionAt(Date.parse('2026-11-14T19:30:00Z'))).toBe('closed'); // Saturday
    expect(sessionAt(Date.parse('2026-07-10T13:45:00Z'))).toBe('regular'); // 09:45 EDT
    expect(
      simulateSnapshot({ symbol: 'X', S: 1, prevClose: 1, asOf: '2026-11-14T19:30:00Z', baseIv: 0.3 }).session,
    ).toBe('closed');
    expect(expiryMs('2026-11-20')).toBeGreaterThan(Date.parse(DEMO_AS_OF));
  });
});
