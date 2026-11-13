// Contract test on a payload recorded from cdn.cboe.com on 2026-11-13 (trimmed to 2 expiries,
// strikes 150-190, plus one adjusted-root contract that must be ignored).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { cboeSource, easternToEpochMs, stampMs } from '../src/cboe.ts';
import { parseOcc, occ } from '../src/symbols.ts';

const payload = JSON.parse(fs.readFileSync(new URL('./fixtures/cboe-nvda.json', import.meta.url), 'utf8'));
const urls: string[] = [];
const fetchJson = async (url: string) => {
  urls.push(url);
  return payload;
};
// 2026-11-13 11:48 UTC = 06:48 New York: pre-market.
const NOW = Date.parse('2026-11-13T11:48:00Z');

describe('Cboe delayed reference source', () => {
  it('reads the timestamp as UTC and trade times as New York time', () => {
    expect(new Date(stampMs('2026-11-13 11:03:28')).toISOString()).toBe('2026-11-13T11:03:28.000Z');
    expect(new Date(easternToEpochMs('2026-11-12T15:59:59')).toISOString()).toBe('2026-11-12T20:59:59.000Z'); // EST
    expect(new Date(easternToEpochMs('2026-07-10T15:59:59')).toISOString()).toBe('2026-07-10T19:59:59.000Z'); // EDT
  });

  it('quotes the underlying, tagged as Cboe and 15 minutes delayed', async () => {
    const src = cboeSource(fetchJson, { now: () => NOW });
    const q = await src.quote!('nvda');
    expect(q).toMatchObject({
      symbol: 'nvda',
      lastPrice: payload.data.current_price,
      regularPrice: payload.data.close, // outside regular hours the regular price is the close
      prevClose: payload.data.prev_day_close,
      session: 'pre',
      source: 'cboe',
      sourceLabel: 'Cboe',
      delayed: true,
      delayMinutes: 15,
    });
    expect(q.asOf).toBe(stampMs(payload.timestamp));
    expect(urls[0]).toBe('https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json');
  });

  it('lists expiries of standard contracts only and builds chain rows the core can price', async () => {
    const src = cboeSource(fetchJson, { now: () => NOW });
    const e = await src.expirations!('NVDA');
    expect(e.expirations).toEqual(['2026-11-20', '2026-12-18']); // the B1VDA 2026-11-13 contract is excluded
    expect(e.source).toBe('cboe');
    const c = await src.optionChain!('NVDA', '2026-12-18');
    expect(c).toMatchObject({ symbol: 'NVDA', expiry: '2026-12-18', source: 'cboe', delayed: true });
    expect(c.calls.map((r) => r.strike)).toEqual([150, 160, 170, 180, 190]);
    expect(c.puts.map((r) => r.strike)).toEqual([150, 160, 170, 180, 190]);
    const raw = payload.data.options.find((o: { option: string }) => o.option === 'NVDA261218C00180000');
    const row = c.calls.find((r) => r.strike === 180)!;
    expect(row).toMatchObject({
      contractSymbol: 'NVDA261218C00180000',
      bid: raw.bid,
      ask: raw.ask,
      lastPrice: raw.last_trade_price,
      openInterest: raw.open_interest,
      volume: raw.volume,
      impliedVolatility: raw.iv,
    });
    expect(row.lastTradeDate).toBe(Math.round(easternToEpochMs(raw.last_trade_time) / 1000));
    await expect(src.optionChain!('NVDA', '2030-01-18')).rejects.toThrow('Cboe has no NVDA contracts for 2030-01-18');
  });

  it('caches the payload per symbol and rejects a symbol Cboe does not have', async () => {
    let n = 0;
    let now = NOW;
    const src = cboeSource(
      async () => {
        n++;
        return payload;
      },
      { now: () => now, cacheMs: 60_000 },
    );
    await src.quote!('NVDA');
    await src.expirations!('NVDA');
    expect(n).toBe(1);
    now += 61_000;
    await src.quote!('NVDA');
    expect(n).toBe(2);
    await expect(cboeSource(async () => ({ error: 'nope' })).quote!('ZZZZ')).rejects.toThrow(
      'Cboe has no delayed quotes for ZZZZ',
    );
  });

  it('round-trips OCC symbols', () => {
    expect(parseOcc('NVDA261218C00185000')).toEqual({ root: 'NVDA', expiry: '2026-12-18', right: 'C', strike: 185 });
    expect(parseOcc(occ('spy', '2027-01-15', 'P', 642.5))).toEqual({
      root: 'SPY',
      expiry: '2027-01-15',
      right: 'P',
      strike: 642.5,
    });
    expect(parseOcc('not an option')).toBeNull();
  });
});
