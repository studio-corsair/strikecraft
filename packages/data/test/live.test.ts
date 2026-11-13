/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over dynamic JSON results */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch, NOW, SYM, S0, R, DIV_YIELD, STRIKES, type FakeOpts } from './fixtures/fake-market.ts';
import { parseLeg, expiryMs, YEAR_MS, bsPrice } from '@strikebench/core';

const h = vi.hoisted(() => ({ impl: null as null | ((u: string, i?: any) => Promise<any>) }));
vi.mock('../src/yahoo/http.ts', () => ({ httpFetch: (u: string, i?: any) => h.impl!(u, i) }));

type Fn = (u: string, i?: any) => Promise<any>;
const resp = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null, getSetCookie: () => [] },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

/** Fresh live.mjs (its chain cache is module-level), optionally wrapping the fake market. */
async function load(o: FakeOpts = {}, wrap?: (base: Fn) => Fn) {
  const base = fakeFetch(o).fn;
  h.impl = wrap ? wrap(base) : base;
  vi.resetModules();
  return import('../src/yahoo/live.ts');
}

let logDir = '';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
  process.env.OPT_LOG_DIR = logDir;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPT_LOG_DIR;
  fs.rmSync(logDir, { recursive: true, force: true });
});

const MARKET = {
  symbol: SYM,
  price: S0,
  session: 'regular',
  regularClose: S0,
  r: R,
  q: DIV_YIELD,
  asOf: new Date(NOW).toISOString(),
};
const NO_LOG_NOTE =
  'No logged pre-event implied moves yet — Yahoo keeps no option history; the chain logger fills this from the next print on.';

function seedSummary(rows: any[]) {
  fs.mkdirSync(path.join(logDir, SYM), { recursive: true });
  fs.writeFileSync(path.join(logDir, SYM, 'summary.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('analyze', () => {
  it('fills option entry/IV from the chain, stock entry from spot, and builds a risk grid from % moves', async () => {
    const live = await load();
    const legs = [parseLeg('+1 C 100 2026-07-17'), parseLeg('+100 S')];
    const out: any = await live.analyze(SYM, legs, { moves: [-5, 5] });
    expect(out.market).toEqual(MARKET);
    expect(out.position.legs[0].iv).toBe(0.55);
    expect(out.position.legs[0].mark).toBeCloseTo(8.0203, 4);
    expect(out.position.legs[1]).toEqual({ qty: 100, type: 'S', entry: S0, mult: 1, iv: null, mark: S0 });
    expect(out.position.cost).toBeCloseTo(10802.03, 2);
    expect(out.position.pnl).toBeCloseTo(0, 6);
    expect(out.position.pnlPct).toBeCloseTo(0, 6);
    expect(out.position.greeks.delta).toBeCloseTo(154.86, 2);
    expect(out.position.greeks.deltaDollars).toBe(15486);
    expect(out.position.greeks.pnlFor1PctMove).toBeCloseTo(155.87, 2);
    expect(out.riskProfile.prices).toEqual([95, 105]);
    expect(out.riskProfile.movesPct).toEqual([-5, 5]);
    expect(out.riskProfile.rows.map((r: any) => r.ivShift)).toEqual([
      -0.1, -0.1, -0.1, -0.1, -0.1, 0, 0, 0, 0, 0, 0.1, 0.1, 0.1, 0.1, 0.1,
    ]);
    expect(out.notes).toEqual([
      'TEST260717C00100000: entry = current mark 8.020252380849271 (mid)',
      'TEST260717C00100000: IV 0.55 from mid vs underlying 100',
      'IV shifts are absolute vol points applied to every leg; P&L in $ for the whole position.',
    ]);
  });

  it('keeps an explicit stock entry and rejects a strike missing from the chain', async () => {
    const live = await load();
    const ms = await live.marketState(SYM);
    const stock: any = { ...parseLeg('+100 S'), entry: 90 };
    expect(await live.fillLegs([stock], ms)).toEqual([]);
    expect(stock.entry).toBe(90);
    await expect(live.fillLegs([parseLeg('+1 C 101 2026-07-17')], ms)).rejects.toThrow(
      'no C 101 in TEST 2026-07-17 chain',
    );
  });
});

describe('chain', () => {
  it('returns term structure, constant-maturity IV and the nearest strikes of one expiry', async () => {
    const live = await load();
    const out: any = await live.chain(SYM, { expiry: '2026-06-19', strikes: 1 });
    expect(out.market).toEqual(MARKET);
    expect(out.constantMaturityAtmIv).toEqual({ d7: 0.55, d30: 0.55, d60: 0.55, d90: 0.55 });
    expect(out.termStructure.map((t: any) => [t.expiry, t.dte, t.atmIv])).toEqual([
      ['2026-06-19', 18.21, 0.55],
      ['2026-07-17', 46.21, 0.55],
    ]);
    expect(out.notes[0]).toBe('Marks are live mids.');
    expect(out.contracts.map((c: any) => c.contract)).toEqual([
      'TEST260619C00095000',
      'TEST260619P00095000',
      'TEST260619C00100000',
      'TEST260619P00100000',
    ]);
    expect(out.contracts[2]).toMatchObject({ right: 'C', strike: 100, mark: 4.991, markSource: 'mid', iv: 0.55 });
    expect(out.contracts[2].delta).toBeCloseTo(0.5307, 4);
  });

  it('limits the term structure to maxDte and omits contracts without an expiry', async () => {
    const live = await load();
    const out: any = await live.chain(SYM, { maxDte: 30 });
    expect(out.termStructure.map((t: any) => t.expiry)).toEqual(['2026-06-19']);
    expect(out.contracts).toBeUndefined();
  });

  it('explains stale marks outside the regular session', async () => {
    const live = await load({ tradingPeriod: 'post' });
    const out: any = await live.chain(SYM);
    expect(out.market.session).toBe('post');
    expect(out.notes[0]).toBe(
      `Session is post: option marks are from the last regular session; IVs solved against the regular close ${out.market.regularClose}.`,
    );
  });
});

/** Replace the underlying's daily closes with alternating ±`step` log moves (annualized RV ≈ step·√252). */
const choppyDaily =
  (step: number) =>
  (base: Fn): Fn =>
  async (url) => {
    const r = await base(url);
    const u = new URL(url);
    if (u.pathname === `/v8/finance/chart/${SYM}` && u.searchParams.get('interval') !== '1m') {
      const body = await r.json();
      const q = body.chart.result[0].indicators.quote[0];
      q.close = q.close.map((_: number, i: number) => 100 * Math.exp(i % 2 ? step : 0));
      q.open = q.close;
      q.high = q.close.map((c: number) => c * 1.001);
      q.low = q.close.map((c: number) => c * 0.999);
      return resp(body);
    }
    return r;
  };

describe('vol', () => {
  it('reports realized windows, HV rank, IV vs RV and says premium is rich', async () => {
    const live = await load();
    const out: any = await live.vol(SYM);
    expect(out.market).toEqual(MARKET);
    expect(out.realized).toEqual({
      closeToClose10d: 0.0313,
      closeToClose20d: 0.0755,
      closeToClose30d: 0.0806,
      closeToClose60d: 0.0774,
      closeToClose120d: 0.0804,
      closeToClose252d: 0.0803,
    });
    expect(out.parkinson20d).toBe(0.1845);
    expect(out.yangZhang20d).toBe(0.2152);
    expect(out.hv20Rank1y.observations).toBe(252);
    expect(out.atmIv30dConstantMaturity).toBe(0.55);
    expect(out.ivMinusRv30).toBe(0.4694);
    expect(out.ivToRvRatio30).toBe(6.823);
    expect(out.ivRank.source).toBe('unavailable');
    expect(out.ivRank.reason).toContain('the chain logger has 0 day(s) so far');
    expect(out.meaning).toBe(
      'Options are pricing 582% more movement than the stock has realized over 30 days — rich premium (typical before earnings). Long options need a move bigger than recent history to pay; sellers are paid for that gap.',
    );
  });

  it('uses the chain logger for IV rank once ≥20 days are logged', async () => {
    seedSummary(
      Array.from({ length: 25 }, (_, i) => ({
        date: `2026-04-${String(i + 1).padStart(2, '0')}`,
        cm30: 0.3 + i * 0.02,
      })),
    );
    const live = await load();
    const out: any = await live.vol(SYM);
    expect(out.ivRank.source).toBe('chain logger (25 days of 30d constant-maturity ATM IV)');
    expect(out.ivRank.current).toBe(0.55);
    expect(out.ivRank.low).toBe(0.3);
    expect(out.ivRank.high).toBeCloseTo(0.78, 10);
  });

  it('says options are cheap when implied is below realized', async () => {
    const live = await load({}, choppyDaily(0.06));
    const out: any = await live.vol(SYM);
    expect(out.ivToRvRatio30).toBeLessThan(0.9);
    expect(out.meaning).toBe(
      'Implied vol is below realized — options are cheap relative to recent movement; long premium has an edge if the regime persists.',
    );
  });

  it('says no edge when implied is in line with realized', async () => {
    const live = await load({}, choppyDaily(0.0346));
    const out: any = await live.vol(SYM);
    expect(out.ivToRvRatio30).toBeGreaterThanOrEqual(0.9);
    expect(out.ivToRvRatio30).toBeLessThanOrEqual(1.2);
    expect(out.meaning).toBe('Implied vol is roughly in line with realized movement — no strong vol edge either way.');
  });

  it('reports insufficient data when there is no listed expiry to read IV from', async () => {
    const noExpiries =
      (base: Fn): Fn =>
      async (url) => {
        const r = await base(url);
        if (new URL(url).pathname.startsWith('/v7/finance/options/')) {
          const body = await r.json();
          body.optionChain.result[0].expirationDates = [];
          return resp(body);
        }
        return r;
      };
    const live = await load({}, noExpiries);
    const out: any = await live.vol(SYM);
    expect(out.atmIv30dConstantMaturity).toBeNull();
    expect(out.ivMinusRv30).toBeNull();
    expect(out.ivToRvRatio30).toBeNull();
    expect(out.meaning).toBe('insufficient data');
  });
});

describe('readLoggedSummary / defaultLogDir', () => {
  it('honours OPT_LOG_DIR, falls back under HOME, and parses jsonl', async () => {
    const live = await load();
    expect(live.defaultLogDir()).toBe(logDir);
    delete process.env.OPT_LOG_DIR;
    expect(live.defaultLogDir()).toBe(`${process.env.HOME}/.local/share/finance-analytics/chains`);
    process.env.OPT_LOG_DIR = logDir;
    expect(live.readLoggedSummary(SYM)).toEqual([]);
    seedSummary([
      { date: '2026-05-01', cm30: 0.4 },
      { date: '2026-05-02', cm30: 0.41 },
    ]);
    expect(live.readLoggedSummary(SYM.toLowerCase(), logDir)).toEqual([
      { date: '2026-05-01', cm30: 0.4 },
      { date: '2026-05-02', cm30: 0.41 },
    ]);
  });

  it('rethrows read errors other than a missing file', async () => {
    const live = await load();
    fs.mkdirSync(path.join(logDir, SYM, 'summary.jsonl'), { recursive: true });
    expect(() => live.readLoggedSummary(SYM)).toThrow(/EISDIR/);
  });
});

describe('ivhist', () => {
  it('backs out a per-contract IV series and tallies rejected days', async () => {
    const live = await load();
    const out: any = await live.ivhist(SYM, { expiry: '2026-07-17', strike: 100, right: 'C' });
    expect(out.contract).toBe('TEST260717C00100000');
    expect(out.market).toEqual(MARKET);
    expect(out.daysTotal).toBe(299);
    expect(out.daysUsable).toBe(0);
    expect(out.rejected).toEqual({ 'outside no-arbitrage bounds': 299 });
    expect(out.contractIvRank).toBeNull();
    expect(out.series.at(-1)).toEqual({
      date: '2026-05-29',
      S: 100,
      optClose: 100,
      volume: 1000000,
      iv: null,
      flag: 'outside no-arbitrage bounds',
      rv20: 0.0755,
      ivMinusRv20: null,
    });
  });
});

/** Add a post-earnings expiry priced at a higher IV, so the term structure implies an event move. */
const POST = '2026-08-21';
const POST_T = Date.UTC(2026, 7, 21) / 1000;
const withPostEventExpiry =
  (base: Fn): Fn =>
  async (url) => {
    const u = new URL(url);
    if (!u.pathname.startsWith('/v7/finance/options/')) return base(url);
    const t = u.searchParams.get('date');
    if (t && +t === POST_T) {
      const T = (expiryMs(POST) - NOW) / YEAR_MS;
      const q = Math.log(1 + DIV_YIELD);
      const row = (K: number, right: 'C' | 'P') => {
        const p = bsPrice({ S: S0, K, T, r: R, q, sigma: 0.75, right });
        return {
          contractSymbol: `${SYM}260821${right}${String(K * 1000).padStart(8, '0')}`,
          strike: K,
          lastPrice: p,
          bid: p - 0.01,
          ask: p + 0.01,
          volume: 100,
          openInterest: 1000,
          impliedVolatility: 0.00001,
          lastTradeDate: NOW / 1000 - 120,
        };
      };
      const options = [{ calls: STRIKES.map((k) => row(k, 'C')), puts: STRIKES.map((k) => row(k, 'P')) }];
      return resp({
        optionChain: { result: [{ quote: { regularMarketPrice: S0 }, expirationDates: [], options }] },
      });
    }
    const body = await (await base(url)).json();
    body.optionChain.result[0].expirationDates.push(POST_T);
    return resp(body);
  };

describe('earnings', () => {
  it('without a post-event expiry: history, no implied move, and position P&L through the print', async () => {
    const live = await load();
    const out: any = await live.earnings(SYM, [parseLeg('+1 C 100 2026-07-17')]);
    expect(out.nextEarnings).toEqual({ date: '2026-07-22', timing: 'AMC', callTimeUtc: null, daysAway: 51.2 });
    expect(out.epsSurprises).toEqual([]);
    expect(out.historicalReactions.source).toBe('SEC 8-K Item 2.02 dates + EDGAR acceptance time');
    expect(out.historicalReactions.stats).toMatchObject({ quarters: 5, meanAbsMovePct: 0.6, upCount: 3, downCount: 2 });
    expect(out.implied).toEqual({
      eventDecomposition: null,
      frontPostEventStraddle: null,
      impliedEventMoveAbsPct: null,
      impliedEventMove1SigmaPct: null,
      vsHistory: null,
      historyOfImpliedVsActual: NO_LOG_NOTE,
    });
    const p = out.positionThroughEvent;
    expect(p.evaluatedAt).toBe('2026-07-23T19:30:00.000Z');
    expect(p.ivBeforeAfter).toEqual([{ leg: '+1 C 100 2026-07-17', ivNow: 0.55, ivAfterCrush: 0.55 }]);
    expect(p.grid).toHaveLength(9);
    expect(p.grid[4]).toEqual({
      movePct: 0,
      price: 100,
      changeWithCrush: -802,
      changeNoCrush: -802,
      pnlVsEntryWithCrush: -802,
    });
    expect(p.grid[8]).toEqual({
      movePct: 1.36,
      price: 101.36,
      changeWithCrush: -666,
      changeNoCrush: -666,
      pnlVsEntryWithCrush: -666,
    });
    expect(p.evUnderHistoricalMoves).toBe(-767);
    expect(p.evUnderHistoricalMovesBothSigns).toBe(-772);
    expect(p.breakEvenMoveWithCrush).toEqual([8.1]);
    expect(p.thetaPlusCrushCostIfFlat).toBe(-802);
    expect(p.notes.at(-1)).toBe(
      'Crushed IV per leg = sqrt((σ²T − E²)/T) with event std E = n/a; postEventIv per expiry: {}',
    );
  });

  it('with a post-event expiry: implied event move vs history, and crushed IV on spanning legs', async () => {
    const live = await load({}, withPostEventExpiry);
    const out: any = await live.earnings(SYM, [parseLeg('+1 C 100 2026-08-21'), parseLeg('+100 S')]);
    const imp = out.implied;
    expect(imp.eventDecomposition.eventMoveStd).toBeGreaterThan(0);
    expect(imp.frontPostEventStraddle.expiry).toBe(POST);
    expect(imp.impliedEventMoveAbsPct).toBeCloseTo(imp.eventDecomposition.eventMoveExpectedAbs * 100, 2);
    expect(imp.impliedEventMove1SigmaPct).toBeCloseTo(imp.eventDecomposition.eventMoveStd * 100, 2);
    expect(imp.vsHistory.historicalMeanAbsPct).toBe(0.6);
    expect(imp.vsHistory.ratio).toBeCloseTo(imp.impliedEventMoveAbsPct / 0.6, 1);
    expect(imp.vsHistory.quartersExceedingImplied).toBe(0);
    expect(imp.vsHistory.meaning).toBe(
      'Options price a bigger move than the historical average — premium is rich into the print; long options need an above-average move.',
    );
    const [leg] = out.positionThroughEvent.ivBeforeAfter;
    expect(leg.leg).toBe('+1 C 100 2026-08-21');
    expect(leg.ivAfterCrush).toBeLessThan(leg.ivNow);
    expect(out.positionThroughEvent.position.legs[1]).toMatchObject({ type: 'S', entry: S0 });
  });

  it('returns early with a note when Yahoo has no upcoming date, and records an SEC failure', async () => {
    const noCalendar =
      (base: Fn): Fn =>
      async (url) => {
        const r = await base(url);
        if (new URL(url).pathname.startsWith('/v10/finance/quoteSummary/')) {
          const body = await r.json();
          delete body.quoteSummary.result[0].calendarEvents;
          body.quoteSummary.result[0].earningsHistory = {
            history: [
              {
                quarter: { fmt: '1Q2026' },
                epsActual: { raw: 1.6 },
                epsEstimate: { raw: 1.5 },
                surprisePercent: { raw: 0.0667 },
              },
              { quarter: { fmt: '4Q2025' }, epsActual: 1.2, epsEstimate: 1.2 },
            ],
          };
          return resp(body);
        }
        return r;
      };
    const live = await load({ secFails: true }, noCalendar);
    const out: any = await live.earnings(SYM);
    expect(out.epsSurprises).toEqual([
      { quarter: '1Q2026', epsActual: 1.6, epsEstimate: 1.5, surprisePct: 6.7 },
      { quarter: '4Q2025', epsActual: 1.2, epsEstimate: 1.2, surprisePct: null },
    ]);
    expect(out.nextEarnings).toBeNull();
    expect(out.note).toBe('no upcoming earnings date from Yahoo');
    expect(out.historicalReactions.source).toMatch(/^unavailable: /);
    expect(out.historicalReactions.quarters).toEqual([]);
    expect(out.implied).toBeUndefined();
  });
});

describe('impliedVsActual', () => {
  it('joins the last pre-event logged implied move with each realized reaction', async () => {
    seedSummary([
      { date: '2026-02-20', nextEarnings: '2026-02-25', eventMoveAbs: 0.04 },
      { date: '2026-02-24', nextEarnings: '2026-02-25', eventMoveAbs: 0.05 },
      { date: '2026-02-26', nextEarnings: '2026-02-25', eventMoveAbs: 0.09 },
      { date: '2025-11-18', nextEarnings: '2025-11-19', eventMoveAbs: null },
    ]);
    const live = await load();
    expect(
      live.impliedVsActual(SYM, [
        { date: '2026-02-25', movePct: -7.5 },
        { date: '2025-11-19', movePct: 2 },
      ]),
    ).toEqual([
      { date: '2026-02-25', impliedAbsPct: 5, actualPct: -7.5, actualOverImplied: 1.5, loggedOn: '2026-02-24' },
    ]);
  });

  it('explains the gap when nothing was logged', async () => {
    const live = await load();
    expect(live.impliedVsActual(SYM, [{ date: '2026-02-25', movePct: 1 }])).toBe(NO_LOG_NOTE);
  });
});

describe('ivFromQuote', () => {
  it('recovers the vol a quote was priced at, using time to expiry from now', async () => {
    const live = await load();
    const T = (expiryMs('2026-07-17') - NOW) / YEAR_MS;
    const p = { S: 100, K: 105, r: 0.04, q: 0.01, right: 'P' as const };
    const px = bsPrice({ ...p, T, sigma: 0.42 });
    expect(live.ivFromQuote(px, { ...p, expiry: '2026-07-17' })).toBeCloseTo(0.42, 6);
  });
});
