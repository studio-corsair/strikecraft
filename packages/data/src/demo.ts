// Demo-data mode: a MarketData source that answers from snapshots instead of the network.
// The snapshot format is the daily chain logger's (yahoo/logger.ts) plus an optional `demo`
// block with what the logger does not record (daily bars, earnings calendar). The hosted demo
// and the UI tests run on this; nothing here touches the network or Node.
//
// Two ways to get snapshots:
//   - recorded: a chain-logger snapshot file, loaded as-is;
//   - simulated: `simulateSnapshot`, a seeded generator that prices a plausible chain from a vol
//     surface with Black-Scholes. The public demo ships simulated data so that no vendor's
//     quotes are redistributed; it is labelled as simulated wherever a price is shown.
import { bsPrice, expiryMs, YEAR_MS } from '@strikecraft/core';
import type { RawOptionRow } from '@strikecraft/core';
import { occ, sessionAt } from './symbols.ts';
import type { DailyBar, EarningsDate, EarningsInfo, MarketData, Session, SourceInfo, SourceTag } from './types.ts';

export interface LoggedContract {
  k: number;
  r: 'C' | 'P';
  b: number;
  a: number;
  l: number;
  v: number;
  oi: number;
  m?: number | null;
  ms?: string;
  iv?: number | null;
  yiv?: number | null;
  d?: number | null;
}

export interface LoggedSnapshot {
  symbol: string;
  /** ISO time the snapshot was taken. */
  loggedAt: string;
  tradingDay: string;
  session: Session;
  S: number;
  Smarks: number;
  r: number;
  q: number;
  chains: { expiry: string; T: number; contracts: LoggedContract[] }[];
}

export interface DemoExtras {
  /** True when the prices were generated, not recorded. */
  simulated?: boolean;
  prevClose?: number;
  exDividendDate?: string | null;
  bars?: DailyBar[];
  earnings?: { info: EarningsInfo; dates: EarningsDate[] };
}

export type DemoSnapshot = LoggedSnapshot & { demo?: DemoExtras };

export const DEMO: SourceInfo = { id: 'demo', label: 'Demo data', delayMinutes: 0 };

export interface DemoSource extends MarketData {
  symbols: string[];
  /** Epoch ms the snapshots were taken: freeze the engine clock here so time-to-expiry is consistent. */
  asOf: number;
  simulated: boolean;
}

export function demoSource(snapshots: DemoSnapshot[]): DemoSource {
  if (!snapshots.length) throw new Error('demo mode needs at least one snapshot');
  const bySym = new Map(snapshots.map((s) => [s.symbol.toUpperCase(), s]));
  const get = (sym: string) => {
    const s = bySym.get(sym.toUpperCase());
    if (!s) throw new Error(`${sym.toUpperCase()} is not in the demo data (have ${[...bySym.keys()].join(', ')})`);
    return s;
  };
  const simulated = snapshots.every((s) => s.demo?.simulated === true);
  const label = simulated ? 'Simulated demo data' : 'Recorded demo data';
  const tagOf = (s: DemoSnapshot): SourceTag => ({
    source: 'demo',
    sourceLabel: label,
    delayed: true,
    delayMinutes: 0,
    asOf: Date.parse(s.loggedAt),
  });
  const toRow = (sym: string, expiry: string, c: LoggedContract): RawOptionRow => ({
    strike: c.k,
    bid: c.b,
    ask: c.a,
    lastPrice: c.l,
    volume: c.v,
    openInterest: c.oi,
    impliedVolatility: c.yiv ?? null,
    contractSymbol: occ(sym, expiry, c.r, c.k),
    lastTradeDate: null,
  });
  return {
    ...DEMO,
    label,
    simulated,
    symbols: [...bySym.keys()],
    asOf: Math.max(...snapshots.map((s) => Date.parse(s.loggedAt))),
    async quote(sym) {
      const s = get(sym);
      const t = Math.round(Date.parse(s.loggedAt) / 1000);
      return {
        symbol: s.symbol,
        regularPrice: s.Smarks,
        regularTime: t,
        lastPrice: s.S,
        lastTime: t,
        prevClose: s.demo?.prevClose ?? s.Smarks,
        session: s.session,
        currency: 'USD',
        ...tagOf(s),
      };
    },
    async expirations(sym) {
      const s = get(sym);
      return { symbol: s.symbol, expirations: s.chains.map((c) => c.expiry).sort(), ...tagOf(s) };
    },
    async optionChain(sym, expiry) {
      const s = get(sym);
      const c = s.chains.find((x) => x.expiry === expiry);
      if (!c) throw new Error(`no expiry ${expiry}; have ${s.chains.map((x) => x.expiry).join(' ')}`);
      const side = (r: 'C' | 'P') =>
        c.contracts
          .filter((x) => x.r === r)
          .map((x) => toRow(s.symbol, expiry, x))
          .sort((a, b) => a.strike - b.strike);
      return { symbol: s.symbol, expiry, calls: side('C'), puts: side('P'), ...tagOf(s) };
    },
    async daily(sym) {
      const bars = get(sym).demo?.bars;
      if (!bars) throw new Error(`the ${sym.toUpperCase()} snapshot has no daily bars recorded`);
      return bars;
    },
    async riskFree() {
      return { r: snapshots[0]!.r, source: `${label} (rate at snapshot time)` };
    },
    async dividendYield(sym) {
      const s = get(sym);
      return { q: s.q, exDividendDate: s.demo?.exDividendDate ?? null };
    },
    async earningsInfo(sym) {
      return get(sym).demo?.earnings?.info ?? { next: null, callTime: null, epsSurprises: [] };
    },
    async earningsDates(sym) {
      return get(sym).demo?.earnings?.dates ?? [];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Simulated snapshots
// ---------------------------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32): the same seed always gives the same market. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Standard normal via Box-Muller. */
  const normal = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

export interface SimulateOptions {
  symbol: string;
  /** Underlying price at the snapshot. */
  S: number;
  /** Previous regular close. */
  prevClose: number;
  /** ISO instant of the snapshot (pick one inside regular hours for two-sided quotes). */
  asOf: string;
  /** Ex-event at-the-money vol, e.g. 0.42. */
  baseIv: number;
  /** Skew: vol points per unit of standardized log-moneyness (negative = puts richer). */
  skew?: number;
  /** Smile curvature per squared standardized moneyness. */
  curvature?: number;
  r?: number;
  q?: number;
  /** Next earnings: date (YYYY-MM-DD, after close) and the 1-sigma move priced for it. */
  earnings?: { date: string; eventStd: number };
  seed?: number;
  /** Years of daily history to generate. */
  historyYears?: number;
}

const DAY = 864e5;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekday = (ms: number) => new Date(ms).getUTCDay();
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Listed expiries: the next 8 Fridays, then the third Friday of each following month out to ~7 months. */
export function listedExpiries(asOfMs: number): string[] {
  const out = new Set<string>();
  const day0 = Date.parse(`${ymd(asOfMs)}T00:00:00Z`);
  let d = day0;
  while (out.size < 8) {
    d += DAY;
    if (weekday(d) === 5) out.add(ymd(d));
  }
  const start = new Date(day0);
  for (let i = 0; i <= 7; i++) {
    const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1);
    const firstFri = first + ((5 - weekday(first) + 7) % 7) * DAY;
    const third = firstFri + 14 * DAY;
    if (third > day0) out.add(ymd(third));
  }
  return [...out].sort();
}

function strikeGrid(S: number, T: number): number[] {
  const step = S < 25 ? 0.5 : S < 60 ? 1 : S < 150 ? 2.5 : S < 400 ? 5 : 10;
  const width = Math.min(0.45, 0.12 + 0.55 * Math.sqrt(T));
  const lo = Math.max(step, Math.floor((S * (1 - width)) / step) * step);
  const hi = Math.ceil((S * (1 + width)) / step) * step;
  const out: number[] = [];
  for (let k = lo; k <= hi + 1e-9; k += step) out.push(round2(k));
  return out;
}

export function simulateSnapshot(o: SimulateOptions): DemoSnapshot {
  const rand = prng(o.seed ?? 7);
  const asOf = Date.parse(o.asOf);
  const r = o.r ?? 0.041,
    q = o.q ?? 0;
  const skew = o.skew ?? -0.035,
    curv = o.curvature ?? 0.012;
  const eventEnd = o.earnings ? expiryMs(o.earnings.date) + DAY : Infinity;
  const E2 = o.earnings ? o.earnings.eventStd ** 2 : 0;

  const chains = listedExpiries(asOf).map((expiry) => {
    const T = Math.max((expiryMs(expiry) - asOf) / YEAR_MS, 0.5 / 365);
    // Mild upward term slope, plus the earnings variance for expiries that span the print.
    const exEvent = o.baseIv * (1 + 0.05 * Math.sqrt(T));
    const atm = Math.sqrt((exEvent ** 2 * T + (expiryMs(expiry) >= eventEnd ? E2 : 0)) / T);
    const F = o.S * Math.exp((r - q) * T);
    const contracts: LoggedContract[] = [];
    for (const k of strikeGrid(o.S, T)) {
      const m = Math.log(k / F) / (atm * Math.sqrt(T));
      const iv = Math.max(0.05, atm + skew * m + curv * m * m);
      for (const right of ['C', 'P'] as const) {
        const mid = bsPrice({ S: o.S, K: k, T, r, q, sigma: iv, right });
        const half = Math.max(0.01, mid * 0.006 + 0.01);
        const b = Math.max(0, round2(mid - half)),
          a = round2(Math.max(mid + half, b + 0.01));
        const liquidity = Math.exp(-0.5 * m * m) * (0.4 + rand.next());
        const otm = right === 'C' ? k >= F : k <= F;
        contracts.push({
          k,
          r: right,
          b,
          a,
          l: round2(Math.max(0.01, mid + (rand.next() - 0.5) * half)),
          v: Math.round(liquidity * (otm ? 9000 : 2500) * (0.3 + 1 / (1 + 12 * T))),
          oi: Math.round(liquidity * (otm ? 30000 : 9000) * (0.5 + 2 * Math.min(T, 0.5))),
        });
      }
    }
    return { expiry, T, contracts };
  });

  // Daily history: geometric Brownian motion with a jump on each past earnings day, scaled so the
  // last close is the previous close.
  const years = o.historyYears ?? 5;
  const pastEarnings: EarningsDate[] = [];
  if (o.earnings) {
    let d = Date.parse(`${o.earnings.date}T00:00:00Z`);
    for (let i = 0; i < years * 4; i++) {
      d -= 91 * DAY;
      while (weekday(d) === 0 || weekday(d) === 6) d += DAY;
      pastEarnings.unshift({ date: ymd(d), acceptedET: '16:20', timing: 'AMC' });
    }
  }
  const reactionDays = new Set(
    pastEarnings.map((e) => {
      let d = Date.parse(`${e.date}T00:00:00Z`) + DAY;
      while (weekday(d) === 0 || weekday(d) === 6) d += DAY;
      return ymd(d);
    }),
  );
  const days: number[] = [];
  for (let d = Date.parse(`${ymd(asOf)}T00:00:00Z`) - DAY; days.length < years * 252; d -= DAY)
    if (weekday(d) !== 0 && weekday(d) !== 6) days.unshift(d);
  const dailyVol = (o.baseIv * 0.85) / Math.sqrt(252);
  let px = 100;
  const raw = days.map((d) => {
    const open = px * Math.exp(rand.normal() * dailyVol * 0.35);
    const jump = reactionDays.has(ymd(d)) ? rand.normal() * (o.earnings?.eventStd ?? 0) * 0.9 : 0;
    const close = open * Math.exp(rand.normal() * dailyVol * 0.94 + jump + 0.0003);
    const hi = Math.max(open, close) * (1 + Math.abs(rand.normal()) * dailyVol * 0.4);
    const lo = Math.min(open, close) * (1 - Math.abs(rand.normal()) * dailyVol * 0.4);
    px = close;
    return { d, open, hi, lo, close, volume: Math.round(2e7 * (0.6 + rand.next())) };
  });
  const scale = o.prevClose / px;
  const bars: DailyBar[] = raw.map((b) => ({
    date: ymd(b.d),
    t: Math.round((b.d + 20 * 3600e3) / 1000),
    open: round2(b.open * scale),
    high: round2(b.hi * scale),
    low: round2(b.lo * scale),
    close: round2(b.close * scale),
    adjclose: round2(b.close * scale),
    volume: b.volume,
  }));

  const session = sessionAt(asOf);

  return {
    symbol: o.symbol,
    loggedAt: new Date(asOf).toISOString(),
    tradingDay: ymd(asOf),
    session,
    S: o.S,
    Smarks: session === 'regular' ? o.S : o.prevClose,
    r,
    q,
    chains,
    demo: {
      simulated: true,
      prevClose: o.prevClose,
      exDividendDate: null,
      bars,
      earnings: o.earnings
        ? {
            info: {
              next: o.earnings.date,
              callTime: Math.round((expiryMs(o.earnings.date) + 3600e3) / 1000),
              epsSurprises: pastEarnings.slice(-4).map((e, i) => {
                const est = round2(1 + i * 0.12);
                const act = round2(est * (1 + (rand.next() - 0.35) * 0.12));
                return {
                  quarter: e.date,
                  epsActual: act,
                  epsEstimate: est,
                  surprisePct: Math.round((act / est - 1) * 1000) / 10,
                };
              }),
            },
            dates: pastEarnings,
          }
        : undefined,
    },
  };
}

/** The markets the public demo ships with. Simulated: not real quotes. */
export const DEMO_AS_OF = '2026-11-13T19:30:00.000Z'; // 14:30 New York, regular session

export function defaultDemoSnapshots(): DemoSnapshot[] {
  return [
    simulateSnapshot({
      symbol: 'NVDA',
      S: 170.89,
      prevClose: 166.19,
      asOf: DEMO_AS_OF,
      baseIv: 0.5,
      earnings: { date: '2026-11-17', eventStd: 0.085 },
      q: 0.0006,
      seed: 11,
    }),
    simulateSnapshot({
      symbol: 'SPY',
      S: 684.2,
      prevClose: 681.75,
      asOf: DEMO_AS_OF,
      baseIv: 0.15,
      skew: -0.05,
      q: 0.011,
      seed: 12,
    }),
    simulateSnapshot({
      symbol: 'AAPL',
      S: 268.4,
      prevClose: 266.1,
      asOf: DEMO_AS_OF,
      baseIv: 0.26,
      earnings: { date: '2027-01-28', eventStd: 0.04 },
      q: 0.004,
      seed: 13,
    }),
    simulateSnapshot({
      symbol: 'TSLA',
      S: 412.3,
      prevClose: 405.6,
      asOf: DEMO_AS_OF,
      baseIv: 0.58,
      earnings: { date: '2027-01-20', eventStd: 0.09 },
      seed: 14,
    }),
  ];
}
