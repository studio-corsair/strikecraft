// One interface for every place a price can come from. A source implements the methods it can
// serve; the ladder (ladder.ts) stacks sources so the first one that answers wins. Every quote,
// expiration list and chain slice carries a SourceTag, so a delayed number never passes for live.
import type { RawOptionRow } from '@strikebench/core';

export type SourceId =
  'tradier' | 'tastytrade' | 'schwab' | 'alpaca' | 'tradestation' | 'etrade' | 'ibkr' | 'yahoo' | 'cboe' | 'demo';

export interface SourceTag {
  /** Which source produced this value. */
  source: SourceId;
  /** Human label for the top bar, e.g. "Tradier" or "Yahoo". */
  sourceLabel: string;
  /** True when the source is not real-time. */
  delayed: boolean;
  /** Nominal delay in minutes (0 = real-time). */
  delayMinutes: number;
  /** Epoch ms the value refers to (trade/quote time when the source gives one, else fetch time). */
  asOf: number;
}

export type Session = 'regular' | 'pre' | 'post' | 'closed';

export interface UnderlyingQuote extends SourceTag {
  symbol: string;
  regularPrice: number;
  /** Epoch seconds of regularPrice. */
  regularTime: number;
  /** Latest print including extended hours. */
  lastPrice: number;
  /** Epoch seconds of lastPrice. */
  lastTime: number;
  prevClose: number;
  session: Session;
  currency: string;
  bid?: number | null;
  ask?: number | null;
}

export interface ExpirationList extends SourceTag {
  symbol: string;
  /** YYYY-MM-DD, ascending. */
  expirations: string[];
}

export interface ChainSlice extends SourceTag {
  symbol: string;
  expiry: string;
  calls: RawOptionRow[];
  puts: RawOptionRow[];
}

export interface DailyBar {
  date: string;
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  adjclose: number;
  volume: number;
}

export interface EarningsDate {
  date: string;
  acceptedET: string;
  timing: 'AMC' | 'BMO' | 'DURING';
}

export interface EpsSurprise {
  quarter: string | undefined;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
}

export interface EarningsInfo {
  /** Next announcement date (YYYY-MM-DD) or null when unknown. */
  next: string | null;
  /** Epoch seconds of the earnings call, when known. */
  callTime: number | null;
  epsSurprises: EpsSurprise[];
}

export interface MarketDataMethods {
  quote(sym: string): Promise<UnderlyingQuote>;
  expirations(sym: string): Promise<ExpirationList>;
  optionChain(sym: string, expiry: string): Promise<ChainSlice>;
  daily(sym: string, range?: string): Promise<DailyBar[]>;
  riskFree(): Promise<{ r: number; source: string }>;
  dividendYield(sym: string): Promise<{ q: number; exDividendDate: string | null }>;
  earningsInfo(sym: string): Promise<EarningsInfo>;
  /** Past earnings release dates with release timing. */
  earningsDates(sym: string): Promise<EarningsDate[]>;
}

export type MarketDataMethod = keyof MarketDataMethods;

export interface SourceInfo {
  id: SourceId;
  label: string;
  /** Nominal delay in minutes (0 = real-time). */
  delayMinutes: number;
}

/** A single source: implements whichever methods it can serve. */
export interface MarketDataSource extends SourceInfo, Partial<MarketDataMethods> {}

/** A complete market-data provider (a ladder, or a source that implements everything). */
export interface MarketData extends SourceInfo, MarketDataMethods {}

export const tag = (s: SourceInfo, asOf: number = Date.now()): SourceTag => ({
  source: s.id,
  sourceLabel: s.label,
  delayed: s.delayMinutes > 0,
  delayMinutes: s.delayMinutes,
  asOf,
});
