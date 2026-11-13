import { describe, it, expect } from 'vitest';
import { createLadder } from '../src/ladder.ts';
import { tag } from '../src/types.ts';
import type { MarketDataSource, SourceInfo, UnderlyingQuote } from '../src/types.ts';

const BROKER: SourceInfo = { id: 'tradier', label: 'Tradier', delayMinutes: 0 };
const YAHOO: SourceInfo = { id: 'yahoo', label: 'Yahoo', delayMinutes: 15 };
const CBOE: SourceInfo = { id: 'cboe', label: 'Cboe', delayMinutes: 15 };

const quoteFrom = (s: SourceInfo, price: number): UnderlyingQuote => ({
  symbol: 'TEST',
  regularPrice: price,
  regularTime: 1_800_000_000,
  lastPrice: price,
  lastTime: 1_800_000_000,
  prevClose: price - 1,
  session: 'regular',
  currency: 'USD',
  ...tag(s, 1_800_000_000_000),
});

function source(info: SourceInfo, price: number, o: { fail?: () => boolean; calls?: string[] } = {}): MarketDataSource {
  return {
    ...info,
    async quote() {
      o.calls?.push(info.id);
      if (o.fail?.()) throw new Error(`${info.label} is down`);
      return quoteFrom(info, price);
    },
  };
}

describe('market-data ladder', () => {
  it('answers from the first rung and tags the quote with that source as real-time', async () => {
    const ladder = createLadder([source(BROKER, 101), source(YAHOO, 100)]);
    const q = await ladder.quote('TEST');
    expect(q).toMatchObject({
      lastPrice: 101,
      source: 'tradier',
      sourceLabel: 'Tradier',
      delayed: false,
      delayMinutes: 0,
    });
    expect(q.asOf).toBe(1_800_000_000_000);
    expect(ladder.lastServedBy()).toEqual({ quote: 'tradier' });
  });

  it('falls to the next rung when the first fails, and the answer says it is delayed', async () => {
    const ladder = createLadder([source(BROKER, 101, { fail: () => true }), source(YAHOO, 100), source(CBOE, 99)]);
    const q = await ladder.quote('TEST');
    expect(q).toMatchObject({ lastPrice: 100, source: 'yahoo', delayed: true, delayMinutes: 15 });
    const st = ladder.status();
    expect(st.map((r) => [r.rank, r.id, r.state])).toEqual([
      [1, 'tradier', 'error'],
      [2, 'yahoo', 'delayed'],
      [3, 'cboe', 'idle'],
    ]);
    expect(st[0]!.lastError).toBe('quote: Tradier is down');
  });

  it('skips a rung that does not implement the method', async () => {
    const earningsOnly: MarketDataSource = { ...BROKER, earningsDates: async () => [] };
    const ladder = createLadder([earningsOnly, source(YAHOO, 100)]);
    expect((await ladder.quote('TEST')).source).toBe('yahoo');
    expect(ladder.status()[0]!.serves).toEqual(['earningsDates']);
  });

  it('rests a failed rung for the cooldown, then asks it first again', async () => {
    let now = 0;
    let down = true;
    const calls: string[] = [];
    const ladder = createLadder([source(BROKER, 101, { fail: () => down, calls }), source(YAHOO, 100, { calls })], {
      cooldownMs: 30_000,
      now: () => now,
    });
    expect((await ladder.quote('TEST')).source).toBe('yahoo');
    expect(calls).toEqual(['tradier', 'yahoo']);
    now = 10_000; // still cooling: Yahoo is asked first and the broker is not touched
    calls.length = 0;
    expect((await ladder.quote('TEST')).source).toBe('yahoo');
    expect(calls).toEqual(['yahoo']);
    now = 31_000; // cooldown over and the broker is back
    down = false;
    calls.length = 0;
    expect((await ladder.quote('TEST')).source).toBe('tradier');
    expect(calls).toEqual(['tradier']);
    expect(ladder.status()[0]).toMatchObject({ state: 'live', lastError: null });
  });

  it('still tries a cooling rung when it is the only one left', async () => {
    let now = 0;
    let fails = 1;
    const ladder = createLadder([source(BROKER, 101, { fail: () => fails-- > 0 })], { now: () => now });
    await expect(ladder.quote('TEST')).rejects.toThrow(
      'no market-data source answered quote (Tradier: Tradier is down)',
    );
    now = 1000;
    expect((await ladder.quote('TEST')).lastPrice).toBe(101);
  });

  it('names every failure when no rung answers, and rejects a method nobody provides', async () => {
    const ladder = createLadder([source(BROKER, 1, { fail: () => true }), source(YAHOO, 1, { fail: () => true })]);
    await expect(ladder.quote('TEST')).rejects.toThrow(
      'no market-data source answered quote (Tradier: Tradier is down; Yahoo: Yahoo is down)',
    );
    await expect(ladder.daily('TEST')).rejects.toThrow('no market-data source provides daily');
    expect(() => createLadder([])).toThrow('a ladder needs at least one market-data source');
  });
});
