// Tradier adapter (REST + streaming). Sandbox = paper trading on 15-minute-delayed data; live =
// real-time quotes and real orders. Docs: https://docs.tradier.com (public API reference).
import type { RawOptionRow } from '@strikebench/core';
import { tag } from '../types.ts';
import type { DailyBar, MarketDataSource, Session, SourceInfo } from '../types.ts';
import { parseOcc } from '../symbols.ts';
import { BrokerError, LiveTradingDisabledError, validateOrder } from './types.ts';
import type {
  Balances,
  Broker,
  BrokerAccount,
  BrokerCapabilities,
  BrokerEnv,
  BrokerPosition,
  FetchLike,
  OrderLeg,
  OrderPreview,
  OrderRequest,
  OrderSide,
  OrderState,
  OrderStatus,
  PlacedOrder,
  StreamQuote,
} from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export const TRADIER_HOSTS = {
  sandbox: 'sandbox.tradier.com',
  live: 'api.tradier.com',
  stream: 'ws.tradier.com',
} as const;

export const TRADIER_CAPABILITIES: BrokerCapabilities = {
  optionOrders: true,
  multiLeg: true,
  realTimeOptionQuotes: 'with funded account',
  realTimeQuality: 'yes',
  paperTrading: true,
  paperNote: 'sandbox, 15-min delayed quotes',
  signIn: 'API token',
  streaming: true,
};

/** The slice of the WebSocket API the stream uses (global WebSocket in browsers and Node 22+). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export interface TradierOptions {
  token: string;
  env: BrokerEnv;
  fetch: FetchLike;
  /** Only an explicit user setting may turn this on. Default false. */
  allowLiveOrders?: boolean;
  /** WebSocket constructor for live streaming; without one (and always in sandbox) quotes are polled. */
  WebSocket?: new (url: string) => SocketLike;
  /** Polling interval for the sandbox / fallback stream (ms). Default 5000. */
  pollMs?: number;
  now?: () => number;
}

const arr = <T>(x: T | T[] | null | undefined | 'null'): T[] =>
  x == null || x === 'null' ? [] : Array.isArray(x) ? x : [x];
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

const STATE: Record<string, OrderState> = {
  open: 'open',
  partially_filled: 'partially_filled',
  filled: 'filled',
  expired: 'expired',
  canceled: 'canceled',
  pending: 'pending',
  rejected: 'rejected',
  error: 'rejected',
  held: 'pending',
  calculated: 'pending',
  accepted_for_bidding: 'pending',
};

/** Tradier order form fields for an OrderRequest. Exported for tests and for the request preview. */
export function tradierOrderParams(o: OrderRequest): Record<string, string> {
  validateOrder(o);
  const base: Record<string, string> = { symbol: o.underlying.toUpperCase(), duration: o.duration, type: o.type };
  if (o.price != null && o.type !== 'market' && o.type !== 'even') base.price = String(o.price);
  if (o.tag) base.tag = o.tag;
  const isOption = (l: OrderLeg) => parseOcc(l.symbol) != null;
  if (o.legs.length === 1) {
    const l = o.legs[0]!;
    if (isOption(l))
      return { class: 'option', ...base, option_symbol: l.symbol, side: l.side, quantity: String(l.quantity) };
    if (l.side !== 'buy' && l.side !== 'sell') throw new Error('a stock leg is bought or sold, not opened or closed');
    return { class: 'equity', ...base, side: l.side, quantity: String(l.quantity) };
  }
  // Stock + options = combo; options only = multileg.
  const p: Record<string, string> = { class: o.legs.every(isOption) ? 'multileg' : 'combo', ...base };
  o.legs.forEach((l, i) => {
    if (isOption(l)) p[`option_symbol[${i}]`] = l.symbol;
    p[`side[${i}]`] = l.side;
    p[`quantity[${i}]`] = String(l.quantity);
  });
  return p;
}

/** A daily-bar range like "1y", "6mo", "5d" as a start date (YYYY-MM-DD). */
export function rangeStart(range: string, nowMs: number): string {
  const m = /^(\d+)(d|mo|y)$/.exec(range);
  if (!m) throw new Error(`bad range "${range}" (want e.g. 5d, 6mo, 1y)`);
  const n = Number(m[1]);
  const d = new Date(nowMs);
  if (m[2] === 'd') d.setUTCDate(d.getUTCDate() - n);
  else if (m[2] === 'mo') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

export function tradierBroker(opts: TradierOptions): Broker {
  const { env, token } = opts;
  const now = opts.now ?? Date.now;
  const host = env === 'sandbox' ? TRADIER_HOSTS.sandbox : TRADIER_HOSTS.live;
  const base = `https://${host}/v1`;
  const allowLive = opts.allowLiveOrders === true;
  const info: SourceInfo = {
    id: 'tradier',
    label: env === 'sandbox' ? 'Tradier sandbox' : 'Tradier',
    delayMinutes: env === 'sandbox' ? 15 : 0,
  };

  async function api(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string> = {},
  ): Promise<Json> {
    const qs = new URLSearchParams(params).toString();
    const url = `${base}${path}${method === 'GET' && qs ? `?${qs}` : ''}`;
    const res = await opts.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? qs : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // error-ok: Tradier answers some errors in plain text; the text itself is reported below
    }
    const errs = arr((body as Json)?.errors?.error as string | string[] | undefined);
    if (!res.ok || errs.length) {
      const why = errs.length ? errs.join('; ') : typeof body === 'string' && body ? body.slice(0, 200) : 'no details';
      throw new BrokerError(`Tradier ${method} ${path} failed (HTTP ${res.status}): ${why}`, res.status, body);
    }
    return body as Json;
  }

  const guardLive = (action: string) => {
    if (env === 'live' && !allowLive) throw new LiveTradingDisabledError('Tradier', action);
  };

  const toLeg = (o: Json): OrderLeg => ({
    symbol: o.option_symbol ?? o.symbol,
    side: o.side as OrderSide,
    quantity: Number(o.quantity),
  });
  const toOrder = (o: Json): OrderStatus => ({
    id: String(o.id),
    state: STATE[o.status] ?? 'pending',
    underlying: o.symbol,
    legs: o.leg ? arr<Json>(o.leg).map(toLeg) : [toLeg(o)],
    type: o.type,
    price: num(o.price),
    duration: o.duration,
    createdAt: o.create_date ?? null,
    filledQuantity: Number(o.exec_quantity ?? 0),
    avgFillPrice: num(o.avg_fill_price),
    tag: o.tag ?? null,
  });

  async function session(): Promise<Session> {
    const c = (await api('GET', '/markets/clock')).clock;
    return c?.state === 'open'
      ? 'regular'
      : c?.state === 'premarket'
        ? 'pre'
        : c?.state === 'postmarket'
          ? 'post'
          : 'closed';
  }

  async function rawQuotes(symbols: string[]): Promise<Json[]> {
    return arr<Json>((await api('GET', '/markets/quotes', { symbols: symbols.join(',') })).quotes?.quote);
  }

  const md: MarketDataSource = {
    ...info,
    async quote(sym) {
      const [rows, sess] = await Promise.all([rawQuotes([sym]), session()]);
      const q = rows[0];
      if (!q || q.last == null) throw new Error(`Tradier has no quote for ${sym.toUpperCase()}`);
      // Outside the regular session `last` stays at the close; the live two-sided quote is the print.
      const mid = q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
      const lastPrice = sess === 'regular' || mid == null ? q.last : Math.round(mid * 100) / 100;
      const tradeMs = typeof q.trade_date === 'number' ? q.trade_date : now();
      const quoteMs = Math.max(q.bid_date ?? 0, q.ask_date ?? 0) || tradeMs;
      return {
        symbol: sym,
        regularPrice: q.last,
        regularTime: Math.round(tradeMs / 1000),
        lastPrice,
        lastTime: Math.round((sess === 'regular' ? tradeMs : quoteMs) / 1000),
        prevClose: q.prevclose ?? q.last,
        session: sess,
        currency: 'USD',
        bid: num(q.bid),
        ask: num(q.ask),
        ...tag(info, sess === 'regular' ? tradeMs : quoteMs),
      };
    },
    async expirations(sym) {
      const d = arr<string>(
        (await api('GET', '/markets/options/expirations', { symbol: sym.toUpperCase() })).expirations?.date,
      );
      if (!d.length) throw new Error(`Tradier lists no option expirations for ${sym.toUpperCase()}`);
      return { symbol: sym, expirations: [...d].sort(), ...tag(info, now()) };
    },
    async optionChain(sym, expiry) {
      const rows = arr<Json>(
        (await api('GET', '/markets/options/chains', { symbol: sym.toUpperCase(), expiration: expiry, greeks: 'true' }))
          .options?.option,
      );
      if (!rows.length) throw new Error(`Tradier has no ${sym.toUpperCase()} chain for ${expiry}`);
      const toRow = (o: Json): RawOptionRow => ({
        strike: o.strike,
        bid: o.bid ?? 0,
        ask: o.ask ?? 0,
        lastPrice: o.last ?? 0,
        volume: o.volume ?? 0,
        openInterest: o.open_interest ?? 0,
        impliedVolatility: o.greeks?.mid_iv ?? null,
        contractSymbol: o.symbol,
        lastTradeDate: typeof o.trade_date === 'number' && o.trade_date > 0 ? Math.round(o.trade_date / 1000) : null,
      });
      const side = (t: string) =>
        rows
          .filter((o) => o.option_type === t && o.root_symbol === sym.toUpperCase())
          .map(toRow)
          .sort((a, b) => a.strike - b.strike);
      return { symbol: sym, expiry, calls: side('call'), puts: side('put'), ...tag(info, now()) };
    },
    async daily(sym, range = '1y') {
      const days = arr<Json>(
        (
          await api('GET', '/markets/history', {
            symbol: sym.toUpperCase(),
            interval: 'daily',
            start: rangeStart(range, now()),
          })
        ).history?.day,
      );
      return days
        .filter((d) => d.close != null)
        .map((d): DailyBar => ({
          date: d.date,
          t: Math.round(Date.parse(`${d.date}T21:00:00Z`) / 1000),
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          adjclose: d.close,
          volume: d.volume ?? 0,
        }));
    },
  };

  async function pollStream(symbols: string[], onQuote: (q: StreamQuote) => void, onError?: (e: Error) => void) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        for (const q of await rawQuotes(symbols))
          onQuote({ symbol: q.symbol, bid: num(q.bid), ask: num(q.ask), last: num(q.last), at: now() });
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      if (!stopped) timer = setTimeout(tick, opts.pollMs ?? 5000);
    };
    await tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return {
    id: 'tradier',
    label: info.label,
    env,
    liveOrdersAllowed: env === 'live' && allowLive,
    capabilities: TRADIER_CAPABILITIES,
    hosts: env === 'sandbox' ? [TRADIER_HOSTS.sandbox] : [TRADIER_HOSTS.live, TRADIER_HOSTS.stream],

    async accounts() {
      const a = arr<Json>((await api('GET', '/user/profile')).profile?.account);
      return a.map((x): BrokerAccount => ({
        id: x.account_number,
        type: x.type,
        optionLevel: num(x.option_level),
        status: x.status,
      }));
    },

    async balances(accountId) {
      const b = (await api('GET', `/accounts/${encodeURIComponent(accountId)}/balances`)).balances ?? {};
      const m = b.margin ?? b.pdt ?? b.cash ?? {};
      return {
        accountId,
        equity: b.total_equity ?? 0,
        cash: b.total_cash ?? 0,
        optionBuyingPower: num(m.option_buying_power) ?? num(m.cash_available),
        stockBuyingPower: num(m.stock_buying_power) ?? num(m.cash_available),
        openPnl: num(b.open_pl),
      } satisfies Balances;
    },

    async positions(accountId) {
      const p = arr<Json>(
        (await api('GET', `/accounts/${encodeURIComponent(accountId)}/positions`)).positions?.position,
      );
      return p.map((x): BrokerPosition => {
        const o = parseOcc(x.symbol);
        return o
          ? {
              symbol: x.symbol,
              underlying: o.root,
              kind: 'option',
              quantity: x.quantity,
              costBasis: x.cost_basis,
              expiry: o.expiry,
              strike: o.strike,
              right: o.right,
              acquired: x.date_acquired ?? null,
            }
          : {
              symbol: x.symbol,
              underlying: x.symbol,
              kind: 'stock',
              quantity: x.quantity,
              costBasis: x.cost_basis,
              acquired: x.date_acquired ?? null,
            };
      });
    },

    async orders(accountId) {
      const o = arr<Json>(
        (await api('GET', `/accounts/${encodeURIComponent(accountId)}/orders`, { includeTags: 'true' })).orders?.order,
      );
      return o.map(toOrder);
    },

    async previewOrder(accountId, order) {
      const res = await api('POST', `/accounts/${encodeURIComponent(accountId)}/orders`, {
        ...tradierOrderParams(order),
        preview: 'true',
      });
      const o = res.order ?? {};
      return {
        ok: o.status === 'ok' && o.result !== false,
        cost: num(o.cost) ?? num(o.order_cost),
        commission: num(o.commission),
        fees: num(o.fees),
        marginChange: num(o.margin_change),
        warnings: arr<string>(o.warnings ?? o.warning),
        raw: res,
      } satisfies OrderPreview;
    },

    async placeOrder(accountId, order) {
      const params = tradierOrderParams(order); // validate before the live check so both run with no request sent
      guardLive('Order');
      const res = await api('POST', `/accounts/${encodeURIComponent(accountId)}/orders`, params);
      const o = res.order ?? {};
      if (o.status !== 'ok' || o.id == null)
        throw new BrokerError(`Tradier did not accept the order: ${JSON.stringify(res).slice(0, 300)}`, 200, res);
      return { id: String(o.id), state: 'pending', raw: res } satisfies PlacedOrder;
    },

    async cancelOrder(accountId, orderId) {
      guardLive('Cancel');
      const res = await api(
        'DELETE',
        `/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}`,
      );
      return { id: String(res.order?.id ?? orderId), ok: res.order?.status === 'ok', raw: res };
    },

    marketData: () => md,

    async stream(symbols, onQuote, onError) {
      const WS = opts.WebSocket;
      // The sandbox has no streaming endpoint; without a WebSocket implementation we also poll.
      if (env === 'sandbox' || !WS) return pollStream(symbols, onQuote, onError);
      const s = (await api('POST', '/markets/events/session')).stream;
      if (!s?.sessionid) throw new Error('Tradier did not open a streaming session');
      const ws = new WS(`wss://${TRADIER_HOSTS.stream}/v1/markets/events`);
      const lastSeen = new Map<string, StreamQuote>();
      ws.onopen = () =>
        ws.send(JSON.stringify({ symbols, sessionid: s.sessionid, filter: ['quote', 'trade'], linebreak: true }));
      ws.onmessage = (ev) => {
        for (const line of String(ev.data).split('\n').filter(Boolean)) {
          let m: Json;
          try {
            m = JSON.parse(line);
          } catch (e) {
            onError?.(
              new Error(`Tradier stream sent a line that is not JSON: ${line.slice(0, 80)} (${(e as Error).message})`),
            );
            continue;
          }
          if (m.type !== 'quote' && m.type !== 'trade') continue;
          const prev = lastSeen.get(m.symbol) ?? { symbol: m.symbol, bid: null, ask: null, last: null, at: 0 };
          const next: StreamQuote =
            m.type === 'quote'
              ? { ...prev, bid: num(m.bid), ask: num(m.ask), at: Number(m.biddate ?? m.askdate) || now() }
              : { ...prev, last: num(Number(m.price ?? m.last)), at: Number(m.date) || now() };
          lastSeen.set(m.symbol, next);
          onQuote(next);
        }
      };
      ws.onerror = () => onError?.(new Error('Tradier stream connection error'));
      return () => ws.close();
    },
  };
}
