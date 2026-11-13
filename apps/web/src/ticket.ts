// Turning the position being built into a broker order. Pure, unit-tested.
import type { LegInput, OrderRequest } from './api.ts';

export type Intent = 'open' | 'close';

/** OCC contract symbol, e.g. NVDA261218C00185000 (same format the data layer uses). */
export const occSymbol = (sym: string, expiry: string, right: 'C' | 'P', strike: number): string =>
  `${sym.toUpperCase()}${expiry.slice(2).replace(/-/g, '')}${right}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/**
 * Net per-share mid of the package: positive = you pay (debit), negative = you receive (credit).
 * Quantities are reduced to their smallest ratio (2×/4× is priced as 1×/2×), the way brokers quote
 * a multi-leg order. Returns null when any leg has no mark.
 */
export function netMid(legs: LegInput[], marks: (number | null | undefined)[]): number | null {
  if (!legs.length) return null;
  const lots = legs.reduce((g, l) => gcd(g, l.type === 'S' ? Math.abs(l.qty) / 100 || 1 : Math.abs(l.qty)), 0) || 1;
  let net = 0;
  for (let i = 0; i < legs.length; i++) {
    const m = marks[i];
    if (m == null || !Number.isFinite(m)) return null;
    const l = legs[i]!;
    const optionOrder = legs.some((x) => x.type !== 'S');
    // In an option order a stock leg of 100 shares counts as one unit per lot.
    const units = l.type === 'S' ? (optionOrder ? l.qty / 100 : l.qty) : l.qty;
    net += (units / lots) * m;
  }
  return net;
}

/** How many times the package is traded (the "quantity" of a multi-leg order). */
export function lotsOf(legs: LegInput[]): number {
  return legs.reduce((g, l) => gcd(g, l.type === 'S' ? Math.abs(l.qty) / 100 || 1 : Math.abs(l.qty)), 0) || 1;
}

export interface TicketOptions {
  symbol: string;
  intent: Intent;
  /** Per-share limit / net price as typed by the user (always positive), or null for a market order. */
  price: number | null;
  duration: 'day' | 'gtc';
  /** Sign of the package at the mid: decides debit vs credit for a multi-leg order. */
  net: number | null;
}

export function buildOrder(legs: LegInput[], o: TicketOptions): OrderRequest {
  if (!legs.length) throw new Error('add at least one leg to the ticket');
  const orderLegs = legs.map((l) => {
    const buy = l.qty > 0;
    if (l.type === 'S')
      return {
        symbol: o.symbol.toUpperCase(),
        side: buy ? ('buy' as const) : ('sell' as const),
        quantity: Math.abs(l.qty),
      };
    if (l.strike == null || !l.expiry) throw new Error('an option leg needs a strike and an expiry');
    const side =
      o.intent === 'open'
        ? buy
          ? ('buy_to_open' as const)
          : ('sell_to_open' as const)
        : buy
          ? ('buy_to_close' as const)
          : ('sell_to_close' as const);
    return { symbol: occSymbol(o.symbol, l.expiry, l.type, l.strike), side, quantity: Math.abs(l.qty) };
  });
  const base = { underlying: o.symbol.toUpperCase(), legs: orderLegs, duration: o.duration };
  if (o.price == null) return { ...base, type: 'market' };
  if (!(o.price >= 0)) throw new Error('the price cannot be negative');
  if (orderLegs.length === 1) {
    if (o.price === 0) throw new Error('a limit order needs a price above zero');
    return { ...base, type: 'limit', price: o.price };
  }
  if (o.price === 0) return { ...base, type: 'even' };
  return { ...base, type: (o.net ?? 1) >= 0 ? 'debit' : 'credit', price: o.price };
}

/** "Limit 4.71", "Net debit 10.20", "Net credit 1.10", "Market", "Even". */
export function priceLabel(order: OrderRequest): string {
  const p = order.price != null ? order.price.toFixed(2) : '';
  switch (order.type) {
    case 'market':
      return 'Market';
    case 'even':
      return 'Even';
    case 'limit':
      return `Limit ${p}`;
    case 'debit':
      return `Net debit ${p}`;
    case 'credit':
      return `Net credit ${p}`;
  }
}

const SIDE_WORDS: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  buy_to_open: 'Buy to open',
  sell_to_open: 'Sell to open',
  buy_to_close: 'Buy to close',
  sell_to_close: 'Sell to close',
};
export const sideWords = (side: string): string => SIDE_WORDS[side] ?? side;

/** "NVDA261218C00185000" → "Dec 18 '26 185 Call"; a ticker stays a ticker. */
export function contractWords(symbol: string): string {
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol);
  if (!m) return `${symbol} shares`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[3]) - 1]} ${Number(m[4])} '${m[2]} ${Number(m[6]) / 1000} ${m[5] === 'C' ? 'Call' : 'Put'}`;
}
