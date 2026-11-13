// Fake Yahoo Finance + SEC EDGAR for network-layer tests. `fakeFetch(opts).fn` stands in for
// src/http.mjs's httpFetch (tests vi.mock it); `calls` records every URL requested.
// Rebuilt 2026-11-13: the harness gap-filler admitted tests importing this file but never copied
// the fixture out of its sandbox.
import { bsPrice } from '@strikebench/core';
import { expiryMs } from '@strikebench/core';

export const SYM = 'TEST';
export const NOW = Date.UTC(2026, 5, 1, 15, 0, 0); // Mon 2026-06-01 11:00 EDT (regular session)
export const NOW_S = NOW / 1000;
export const S0 = 100;
export const R = 0.05;
export const DIV_YIELD = 0.01;
export const IV = 0.55;
export const EXPIRIES = ['2026-06-19', '2026-07-17'];
export const STRIKES = [85, 90, 95, 100, 105, 110, 115];

export type FakeOpts = {
  crumbText?: string;
  calendarFails?: boolean;
  emptyChartFor?: string;
  tradingPeriod?: 'regular' | 'pre' | 'post' | 'closed' | 'none';
  irxFails?: boolean;
  noDividend?: boolean;
  secFails?: boolean;
};

type Bar = { date: string; t: number; open: number; high: number; low: number; close: number | null; volume: number };

/** 300 weekday bars ending the trading day before NOW; bar 10 has a null close. */
export function underlyingBars(): Bar[] {
  const out: Bar[] = [];
  let d = new Date(NOW - 864e5);
  while (out.length < 300) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const i = out.length;
      const close = 100 + 5 * Math.sin(i / 7);
      out.push({
        date: d.toISOString().slice(0, 10),
        t: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30) / 1000,
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000_000 + i,
      });
    }
    d = new Date(d.getTime() - 864e5);
  }
  out.reverse();
  out[10]!.close = null;
  return out;
}

/** 252 daily closes: `body` everywhere, `last` on the final bar. */
function flatBars(body: number, last: number): Bar[] {
  return underlyingBars()
    .slice(-252)
    .map((b, i, a) => ({ ...b, close: i === a.length - 1 ? last : body }));
}

const chartFrom = (bars: Bar[], meta: Record<string, unknown>) => ({
  chart: {
    result: [
      {
        meta,
        timestamp: bars.map((b) => b.t),
        indicators: {
          quote: [
            {
              open: bars.map((b) => b.open),
              high: bars.map((b) => b.high),
              low: bars.map((b) => b.low),
              close: bars.map((b) => b.close),
              volume: bars.map((b) => b.volume),
            },
          ],
        },
      },
    ],
    error: null,
  },
});

function tradingPeriod(kind: FakeOpts['tradingPeriod']) {
  const at = (a: number, b: number) => ({ start: NOW_S + a, end: NOW_S + b });
  switch (kind) {
    case 'none':
      return undefined;
    case 'pre':
      return { pre: at(-100, 3600), regular: at(3600, 7200), post: at(7200, 9000) };
    case 'post':
      return { pre: at(-9000, -7200), regular: at(-7200, -100), post: at(-100, 3600) };
    case 'closed':
      return { pre: at(-90000, -88000), regular: at(-88000, -80000), post: at(-80000, -70000) };
    default:
      return { pre: at(-9000, -3600), regular: at(-3600, 3600), post: at(3600, 9000) };
  }
}

const q = Math.log(1 + DIV_YIELD);
function optionRows(expiry: string) {
  const T = (expiryMs(expiry) - NOW) / (365 * 864e5);
  const ymd = expiry.slice(2).replace(/-/g, '');
  const row = (K: number, right: 'C' | 'P') => {
    const p = bsPrice({ S: S0, K, T, r: R, q, sigma: IV, right });
    return {
      contractSymbol: `${SYM}${ymd}${right}${String(K * 1000).padStart(8, '0')}`,
      strike: K,
      lastPrice: p,
      bid: p - 0.01,
      ask: p + 0.01,
      volume: 100,
      openInterest: 1000,
      impliedVolatility: 0.00001,
      lastTradeDate: NOW_S - 120,
    };
  };
  return { calls: STRIKES.map((K) => row(K, 'C')), puts: STRIKES.map((K) => row(K, 'P')) };
}

const summaryResult = (o: FakeOpts) => ({
  financialData: {
    targetMeanPrice: { raw: 120 },
    targetHighPrice: { raw: 150 },
    targetLowPrice: { raw: 90 },
    numberOfAnalystOpinions: { raw: 40 },
    recommendationKey: 'buy',
  },
  recommendationTrend: { trend: [{ period: '0m', strongBuy: 10, buy: 20, hold: 5, sell: 1, strongSell: 0 }] },
  earningsTrend: {
    trend: [
      {
        period: '0q',
        endDate: '2026-06-30',
        earningsEstimate: { avg: { raw: 1.5 }, growth: { raw: 0.1 } },
        revenueEstimate: { avg: { raw: 5e9 } },
        epsRevisions: { upLast30days: { raw: 5 }, downLast30days: { raw: 1 } },
      },
    ],
  },
  defaultKeyStatistics: {
    shortPercentOfFloat: { raw: 0.15 },
    sharesShort: { raw: 1_000_000 },
    shortRatio: { raw: 2.5 },
    dateShortInterest: { raw: 0, fmt: '2026-05-15' },
  },
  summaryDetail: o.noDividend
    ? {
        trailingAnnualDividendYield: { raw: 0.02 },
        beta: { raw: 1.3 },
        trailingPE: { raw: 30 },
        forwardPE: { raw: 25 },
        marketCap: { raw: 1e12 },
      }
    : {
        dividendYield: { raw: DIV_YIELD },
        dividendRate: { raw: 1 },
        exDividendDate: { raw: 0, fmt: '2026-06-15' },
        beta: { raw: 1.3 },
        trailingPE: { raw: 30 },
        forwardPE: { raw: 25 },
        marketCap: { raw: 1e12 },
      },
  calendarEvents: { earnings: { earningsDate: [{ raw: Date.UTC(2026, 6, 22) / 1000 }] } },
  price: { regularMarketPrice: { raw: S0 } },
});

// EDGAR order: newest first. Includes noise the parser must drop: a 10-Q, a non-2.02 8-K, and an
// 8-K/A that repeats the 2025-08-27 date (the first filing per date wins).
const submissions = {
  filings: {
    recent: {
      form: ['8-K', '10-Q', '8-K', '8-K', '8-K', '8-K', '8-K/A', '8-K'],
      items: ['2.02,9.01', '', '5.02', '2.02', '2.02,9.01', '2.02', '2.02', '2.02'],
      acceptanceDateTime: [
        '2026-03-10T15:00:00.000Z',
        '2026-03-01T21:00:00.000Z',
        '2026-02-26T21:00:00.000Z',
        '2026-02-25T21:05:00.000Z',
        '2025-11-19T21:01:00.000Z',
        '2025-08-27T20:10:00.000Z',
        '2025-08-27T22:30:00.000Z',
        '2025-05-28T11:00:00.000Z',
      ],
    },
  },
};

const resp = (status: number, body: unknown, setCookie: string[] = []) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null, getSetCookie: () => setCookie },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

export function fakeFetch(o: FakeOpts = {}) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'fc.yahoo.com') return resp(404, 'Not found', ['A3=abc; Path=/; Secure', 'B=xyz; Path=/']);
    if (u.pathname.includes('getcrumb')) return resp(200, o.crumbText ?? 'CRUMB');
    if (u.hostname === 'www.sec.gov')
      return o.secFails ? resp(503, 'down') : resp(200, { 0: { cik_str: 1234, ticker: SYM, title: 'Test Corp' } });
    if (u.hostname === 'data.sec.gov') return resp(200, submissions);
    if (u.pathname.startsWith('/v10/finance/quoteSummary/')) {
      const modules = u.searchParams.get('modules') ?? '';
      if (o.calendarFails && modules.includes('calendarEvents')) return resp(500, 'err');
      return resp(200, { quoteSummary: { result: [summaryResult(o)] } });
    }
    if (u.pathname.startsWith('/v7/finance/options/')) {
      const dates = EXPIRIES.map((e) => Date.UTC(+e.slice(0, 4), +e.slice(5, 7) - 1, +e.slice(8, 10)) / 1000);
      const t = u.searchParams.get('date');
      const exp = t ? new Date(+t * 1000).toISOString().slice(0, 10) : EXPIRIES[0]!;
      return resp(200, {
        optionChain: {
          result: [{ quote: { regularMarketPrice: S0 }, expirationDates: dates, options: [optionRows(exp)] }],
        },
      });
    }
    if (u.pathname.startsWith('/v8/finance/chart/')) {
      const sym = decodeURIComponent(u.pathname.split('/').pop()!);
      if (o.emptyChartFor === sym)
        return resp(200, { chart: { result: null, error: { description: 'No data found' } } });
      if (sym === '^IRX')
        return o.irxFails ? resp(404, 'nf') : resp(200, chartFrom(flatBars(5, 5).slice(-5), { regularMarketPrice: 5 }));
      if (sym === '^VIX') return resp(200, chartFrom(flatBars(20, 30), { regularMarketPrice: 30 }));
      if (sym === '^VIX3M') return resp(200, chartFrom(flatBars(24, 25), { regularMarketPrice: 25 }));
      if (sym === '^VXN') return resp(200, chartFrom(flatBars(22, 22), { regularMarketPrice: 22 }));
      if (sym === '^VVIX') return resp(200, chartFrom(flatBars(100, 120), { regularMarketPrice: 120 }));
      if (u.searchParams.get('interval') === '1m') {
        const bars: Bar[] = [-90, -60, -30, 0].map((dt, i) => ({
          date: '',
          t: NOW_S + dt,
          open: 0,
          high: 0,
          low: 0,
          close: [99.5, 100, 100, null][i]!,
          volume: 1,
        }));
        return resp(
          200,
          chartFrom(bars, {
            regularMarketPrice: S0,
            regularMarketTime: NOW_S - 60,
            chartPreviousClose: 99,
            currency: 'USD',
            currentTradingPeriod: tradingPeriod(o.tradingPeriod),
          }),
        );
      }
      return resp(200, chartFrom(underlyingBars(), { regularMarketPrice: S0 }));
    }
    return resp(404, `unrouted ${url}`);
  };
  return { fn, calls };
}
