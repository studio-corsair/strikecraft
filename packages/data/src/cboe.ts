// Cboe public delayed quotes (15 minutes) as a reference source: quote, expirations and chains.
// It is the last rung of the ladder; nothing is built on it beyond a fallback. The fetch function
// is injected so the adapter itself has no Node dependency and tests run on recorded fixtures.
import { occ, parseOcc, sessionAt } from './symbols.ts';
import { tag } from './types.ts';
import type { MarketDataSource, SourceInfo } from './types.ts';
import type { RawOptionRow } from '@strikecraft/core';

export const CBOE: SourceInfo = { id: 'cboe', label: 'Cboe', delayMinutes: 15 };

interface CboeOption {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  open_interest: number;
  volume: number;
  last_trade_price: number;
  last_trade_time: string | null;
}
interface CboePayload {
  timestamp: string;
  data: {
    symbol: string;
    current_price: number;
    bid: number;
    ask: number;
    close: number;
    prev_day_close: number;
    last_trade_time: string;
    options: CboeOption[];
  };
}

export type FetchJson = (url: string) => Promise<unknown>;

/** The payload's own `timestamp` is UTC ("2026-11-13 11:03:28"). */
export const stampMs = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`);

/** Trade times inside the payload are US/Eastern wall-clock without an offset. */
export function easternToEpochMs(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const asUtc = Date.parse(`${iso}Z`);
  // Offset of New York at that instant: 4 h (EDT) or 5 h (EST).
  const hourNy = +new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).format(new Date(asUtc));
  const hourUtc = new Date(asUtc).getUTCHours();
  const offset = (hourUtc - hourNy + 24) % 24;
  return asUtc + offset * 3600e3;
}

export function cboeSource(
  fetchJson: FetchJson,
  opts: { now?: () => number; cacheMs?: number } = {},
): MarketDataSource {
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 60_000;
  const cache = new Map<string, { at: number; p: CboePayload }>();

  async function load(sym: string): Promise<CboePayload> {
    const key = sym.toUpperCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.p;
    const p = (await fetchJson(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(key)}.json`,
    )) as CboePayload;
    if (!p?.data?.options) throw new Error(`Cboe has no delayed quotes for ${key}`);
    cache.set(key, { at: now(), p });
    return p;
  }

  /** Standard contracts only: adjusted roots (e.g. after a split) are left out. */
  const contracts = (p: CboePayload, sym: string) =>
    p.data.options
      .map((o) => ({ o, id: parseOcc(o.option) }))
      .filter((x) => x.id && x.id.root === sym.toUpperCase()) as {
      o: CboeOption;
      id: NonNullable<ReturnType<typeof parseOcc>>;
    }[];

  return {
    ...CBOE,
    async quote(sym) {
      const p = await load(sym);
      const d = p.data;
      const asOf = stampMs(p.timestamp);
      const regularTime = Math.round(easternToEpochMs(d.last_trade_time) / 1000);
      const session = sessionAt(now());
      return {
        symbol: sym,
        regularPrice: session === 'regular' ? d.current_price : d.close,
        regularTime,
        lastPrice: d.current_price,
        lastTime: Math.round(asOf / 1000),
        prevClose: d.prev_day_close,
        session,
        currency: 'USD',
        bid: d.bid,
        ask: d.ask,
        ...tag(CBOE, asOf),
      };
    },
    async expirations(sym) {
      const p = await load(sym);
      const expirations = [...new Set(contracts(p, sym).map((x) => x.id.expiry))].sort();
      return { symbol: sym, expirations, ...tag(CBOE, stampMs(p.timestamp)) };
    },
    async optionChain(sym, expiry) {
      const p = await load(sym);
      const rows = contracts(p, sym).filter((x) => x.id.expiry === expiry);
      if (!rows.length) throw new Error(`Cboe has no ${sym} contracts for ${expiry}`);
      const toRow = ({ o, id }: (typeof rows)[number]): RawOptionRow => ({
        strike: id.strike,
        bid: o.bid,
        ask: o.ask,
        lastPrice: o.last_trade_price,
        volume: o.volume,
        openInterest: o.open_interest,
        impliedVolatility: o.iv || null,
        contractSymbol: occ(sym, id.expiry, id.right, id.strike),
        lastTradeDate: o.last_trade_time ? Math.round(easternToEpochMs(o.last_trade_time) / 1000) : null,
      });
      const side = (right: 'C' | 'P') =>
        rows
          .filter((x) => x.id.right === right)
          .map(toRow)
          .sort((a, b) => a.strike - b.strike);
      return {
        symbol: sym,
        expiry,
        calls: side('C'),
        puts: side('P'),
        ...tag(CBOE, stampMs(p.timestamp)),
      };
    },
  };
}
