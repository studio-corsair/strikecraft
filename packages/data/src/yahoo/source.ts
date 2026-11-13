// Yahoo Finance + SEC EDGAR as a MarketData source: free, public, ~15 minutes delayed, personal
// use. It implements every method, so it is the bottom rung that always has an answer.
// Off-hours behaviour (Yahoo zeroes bid/ask/open interest outside regular hours) is handled where
// the chain is normalized (core buildExpiry: mark falls back to last trade, OI stats are withheld).
import * as data from './data.ts';
import type { Json } from './http.ts';
import { rnd } from '@strikebench/core';
import { tag } from '../types.ts';
import type { MarketData, SourceInfo } from '../types.ts';

export const YAHOO: SourceInfo = { id: 'yahoo', label: 'Yahoo', delayMinutes: 15 };

export function yahooSource(): MarketData {
  return {
    ...YAHOO,
    async quote(sym) {
      const q = await data.quote(sym);
      return { ...q, ...tag(YAHOO, q.lastTime * 1000) };
    },
    async expirations(sym) {
      const c = await data.optionChain(sym);
      return { symbol: sym, expirations: c.expirations, ...tag(YAHOO) };
    },
    async optionChain(sym, expiry) {
      const c = await data.optionChain(sym, expiry);
      return { symbol: sym, expiry, calls: c.calls, puts: c.puts, ...tag(YAHOO) };
    },
    daily: (sym, range) => data.daily(sym, range),
    riskFree: () => data.riskFree(),
    dividendYield: (sym) => data.dividendYield(sym),
    async earningsInfo(sym) {
      const cal = await data.summary(sym, 'calendarEvents,earningsHistory');
      const next: string | null =
        cal.calendarEvents?.earnings?.earningsDate?.map((d: Json) => data.iso(d.raw))?.[0] ?? null;
      return {
        next,
        callTime: cal.calendarEvents?.earnings?.earningsCallDate?.[0]?.raw ?? null,
        epsSurprises: ((cal.earningsHistory?.history ?? []) as Json[]).map((h) => ({
          quarter: h.quarter?.fmt,
          epsActual: data.raw(h.epsActual),
          epsEstimate: data.raw(h.epsEstimate),
          surprisePct: h.surprisePercent ? rnd(data.raw(h.surprisePercent) * 100, 1) : null,
        })),
      };
    },
    earningsDates: (sym) => data.earningsDatesSEC(sym),
  };
}
