/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over dynamic JSON results */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeFetch,
  NOW,
  NOW_S,
  SYM,
  EXPIRIES,
  STRIKES,
  DIV_YIELD,
  underlyingBars,
  type FakeOpts,
} from './fixtures/fake-market.ts';

const h = vi.hoisted(() => ({ impl: null as null | ((u: string, i?: any) => Promise<any>) }));
vi.mock('../src/yahoo/http.ts', () => ({ httpFetch: (u: string, i?: any) => h.impl!(u, i) }));

/** Fresh copy of data.mjs (its crumb + CIK caches are module-level). */
async function load(o: FakeOpts = {}) {
  const f = fakeFetch(o);
  h.impl = f.fn;
  vi.resetModules();
  const data = await import('../src/yahoo/data.ts');
  return { data, calls: f.calls };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
afterEach(() => vi.useRealTimers());

describe('pure helpers', () => {
  it('iso converts epoch seconds to a UTC date', async () => {
    const { data } = await load();
    expect(data.iso(Date.UTC(2026, 11, 18) / 1000 + 3600)).toBe('2026-12-18');
  });
  it('raw unwraps {raw} objects and passes scalars through', async () => {
    const { data } = await load();
    expect(data.raw({ raw: 4.2, fmt: '4.20' })).toBe(4.2);
    expect(data.raw(7)).toBe(7);
    expect(data.raw(null)).toBe(null);
  });
  it('occ builds the OCC contract symbol', async () => {
    const { data } = await load();
    expect(data.occ('nvda', '2026-12-18', 'C', 185)).toBe('NVDA261218C00185000');
    expect(data.occ('SPY', '2026-06-19', 'P', 512.5)).toBe('SPY260619P00512500');
  });
});

describe('Yahoo crumb + quoteSummary', () => {
  it('sends the crumb and the joined session cookies, and caches the crumb', async () => {
    const { data, calls } = await load();
    const s = await data.summary(SYM, 'financialData');
    expect(s.financialData.targetMeanPrice.raw).toBe(120);
    await data.summary(SYM, 'summaryDetail');
    expect(calls.filter((c: string) => c.includes('getcrumb'))).toHaveLength(1);
    expect(calls.filter((c: string) => c.includes('fc.yahoo.com'))).toHaveLength(1);
  });
  it('throws when Yahoo returns an HTML page instead of a crumb', async () => {
    const { data } = await load({ crumbText: '<html>Too Many Requests</html>' });
    await expect(data.summary(SYM, 'price')).rejects.toThrow('could not get Yahoo crumb');
  });
  it('throws on a non-2xx Yahoo response with the URL path (no query)', async () => {
    const { data } = await load({ calendarFails: true });
    await expect(data.summary(SYM, 'calendarEvents')).rejects.toThrow(
      `Yahoo HTTP 500 https://query2.finance.yahoo.com/v10/finance/quoteSummary/${SYM}`,
    );
  });
});

describe('chart / daily', () => {
  it('daily drops null closes and maps OHLCV + adjclose', async () => {
    const { data } = await load();
    const bars = await data.daily(SYM, '2y');
    const src = underlyingBars();
    expect(bars).toHaveLength(src.length - 1);
    expect(bars.find((b) => b.date === src[10]!.date)).toBeUndefined();
    const last = src.at(-1)!;
    expect(bars.at(-1)).toMatchObject({
      date: last.date,
      close: last.close,
      adjclose: last.close,
      volume: last.volume,
    });
  });
  it('chart throws with Yahoo error description when there is no result', async () => {
    const { data } = await load({ emptyChartFor: 'NOPE' });
    await expect(data.chart('NOPE', '1y', '1d')).rejects.toThrow('no chart for NOPE: No data found');
  });
});

describe('quote', () => {
  it('uses the latest non-null intraday print newer than the regular-market time', async () => {
    const { data } = await load();
    expect(await data.quote(SYM)).toEqual({
      symbol: SYM,
      regularPrice: 100,
      regularTime: NOW_S - 60,
      lastPrice: 100,
      lastTime: NOW_S - 30,
      prevClose: 99,
      session: 'regular',
      currency: 'USD',
    });
  });
  it.each([
    ['pre', 'pre'],
    ['post', 'post'],
    ['closed', 'closed'],
    ['none', 'regular'],
  ] as const)('trading period %s → session %s', async (tp, want) => {
    const { data } = await load({ tradingPeriod: tp });
    expect((await data.quote(SYM)).session).toBe(want);
  });
});

describe('optionChain', () => {
  it('with no expiry returns the expirations list and no rows', async () => {
    const { data } = await load();
    const c = await data.optionChain(SYM);
    expect(c.expirations).toEqual(EXPIRIES);
    expect(c.calls).toEqual([]);
    expect(c.puts).toEqual([]);
  });
  it('with an expiry returns that expiry rows', async () => {
    const { data } = await load();
    const c = await data.optionChain(SYM, '2026-06-19');
    expect(c.calls.map((x: any) => x.strike)).toEqual(STRIKES);
    expect(c.puts[0]!.contractSymbol).toBe('TEST260619P00085000');
  });
  it('rejects an expiry Yahoo does not list', async () => {
    const { data } = await load();
    await expect(data.optionChain(SYM, '2026-06-12')).rejects.toThrow(
      `no expiry 2026-06-12; have ${EXPIRIES.join(' ')}`,
    );
  });
});

describe('riskFree / dividendYield', () => {
  it('riskFree reads ^IRX percent', async () => {
    const { data } = await load();
    expect(await data.riskFree()).toEqual({ r: 0.05, source: '^IRX 13-week T-bill' });
  });
  it('riskFree falls back to 4% and says why', async () => {
    const { data } = await load({ irxFails: true });
    const r = await data.riskFree();
    expect(r.r).toBe(0.04);
    expect(r.source).toBe('fallback 4% (Yahoo HTTP 404 https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX)');
  });
  it('dividendYield converts to a continuous yield and returns the ex-date', async () => {
    const { data } = await load();
    expect(await data.dividendYield(SYM)).toEqual({ q: Math.log(1 + DIV_YIELD), exDividendDate: '2026-06-15' });
  });
  it('dividendYield falls back to the trailing yield', async () => {
    const { data } = await load({ noDividend: true });
    expect(await data.dividendYield(SYM)).toEqual({ q: Math.log(1.02), exDividendDate: null });
  });
});

describe('earningsDatesSEC', () => {
  it('keeps 8-K Item 2.02 filings, classifies timing in ET, dedupes, sorts', async () => {
    const { data } = await load();
    expect(await data.earningsDatesSEC(SYM)).toEqual([
      { date: '2025-05-28', acceptedET: '07:00', timing: 'BMO' },
      { date: '2025-08-27', acceptedET: '16:10', timing: 'AMC' },
      { date: '2025-11-19', acceptedET: '16:01', timing: 'AMC' },
      { date: '2026-02-25', acceptedET: '16:05', timing: 'AMC' },
      { date: '2026-03-10', acceptedET: '11:00', timing: 'DURING' },
    ]);
  });
  it('throws for a ticker with no CIK', async () => {
    const { data } = await load();
    await expect(data.earningsDatesSEC('ZZZZ')).rejects.toThrow('no SEC CIK for ZZZZ');
  });
  it('throws when the SEC ticker map is unavailable', async () => {
    const { data } = await load({ secFails: true });
    await expect(data.earningsDatesSEC(SYM)).rejects.toThrow('SEC tickers HTTP 503');
  });
});
