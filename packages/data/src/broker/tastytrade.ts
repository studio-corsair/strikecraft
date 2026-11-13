// tastytrade adapter (REST + DXLink streaming). Sandbox = the certification environment (simulated
// money, orders never reach a market); live = real orders.
//
// Verified 2026-11-13 against tastytrade's public developer docs and OpenAPI specs:
//   - Auth (OAuth2 only; the legacy POST /sessions login was decommissioned 2026-02-11):
//       https://developer.tastytrade.com/docs/authentication/oauth2/  and  /docs/get-started
//     POST {base}/oauth/token {grant_type: refresh_token, refresh_token, client_secret, client_id?}
//     -> access_token, valid 15 minutes; refresh tokens do not expire; `User-Agent: product/version`
//     is required on every request. Sandbox and production are separate OAuth applications.
//   - Sandbox (cert) facts and quirks: https://developer.tastytrade.com/docs/sandbox/
//     (REST /market-data and /market-metrics answer 502 there, so this adapter has no REST quote).
//   - Orders: https://developer.tastytrade.com/docs/guides/place-an-equity-order ,
//     /docs/guides/multi-leg-spreads/ , /docs/concepts/order-lifecycle/ , /reference/orders and
//     https://developer.tastytrade.com/openapi/orders.json (dry-run, submit, search, live, cancel;
//     actions "Buy to Open" / "Sell to Open" / "Buy to Close" / "Sell to Close" / "Buy" / "Sell";
//     time-in-force "Day" | "GTC"; order-type "Limit" | "Market"; price-effect "Debit" | "Credit").
//   - Balances / positions: https://developer.tastytrade.com/docs/concepts/positions-and-balances/
//     and /openapi/balances-and-positions.json
//   - Accounts: GET /customers/me/accounts (items of {account, authority-level}); schema from
//     /openapi/accounts-and-customers.json
//   - Symbology (padded OCC: root padded to 6 chars, yymmdd, C/P, strike*1000 in 8 digits):
//     https://developer.tastytrade.com/docs/concepts/instruments-and-symbology/
//   - Nested chain: GET /option-chains/{symbol}/nested, schema in /openapi/instruments.json
//   - Streaming: https://developer.tastytrade.com/docs/guides/stream-market-data
//     GET /api-quote-tokens -> {token, dxlink-url, level}; DXLink SETUP / AUTH / CHANNEL_REQUEST /
//     FEED_SETUP / FEED_SUBSCRIPTION / FEED_DATA (COMPACT).
import type { MarketDataSource, SourceInfo } from '../types.ts';
import { tag } from '../types.ts';
import { occ, parseOcc } from '../symbols.ts';
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
import type { SocketLike } from './tradier.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export const TASTYTRADE_HOSTS = {
  sandbox: 'api.cert.tastyworks.com',
  live: 'api.tastyworks.com',
  // UNVERIFIED: the docs only show the placeholder wss://dxlink.example.com/realtime. The real
  // DXLink URL comes back from GET /api-quote-tokens; it is accepted only on these domains.
  dxlinkSuffixes: ['.tastyworks.com', '.tastytrade.com', '.dxfeed.com'],
} as const;

export const TASTYTRADE_CAPABILITIES: BrokerCapabilities = {
  optionOrders: true,
  multiLeg: true,
  realTimeOptionQuotes: 'streamed over DXLink with an API quote token',
  realTimeQuality: 'partial',
  paperTrading: true,
  paperNote: 'certification sandbox, simulated fills; no REST quotes',
  signIn: 'OAuth2 client secret + refresh token',
  streaming: true,
};

export type TastytradeAuth =
  /** Personal OAuth2 grant: refresh token + client secret (my.tastytrade.com > API > OAuth Applications). */
  | { refreshToken: string; clientSecret: string; clientId?: string }
  /** A ready access token. It lives 15 minutes and cannot be refreshed here. */
  | { accessToken: string };

export interface TastytradeOptions {
  auth: TastytradeAuth;
  env: BrokerEnv;
  fetch: FetchLike;
  /** Only an explicit user setting may turn this on. Default false. */
  allowLiveOrders?: boolean;
  /** WebSocket constructor for DXLink streaming; without one, stream() throws an explanatory error. */
  WebSocket?: new (url: string) => SocketLike;
  /** `product/version`, required by tastytrade on every request. */
  userAgent?: string;
  now?: () => number;
}

const arr = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
/** tastytrade serializes decimals as JSON strings ("150.25"); accept both. */
const num = (x: unknown): number | null => {
  const v = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const signed = (x: unknown, effect: unknown): number | null => {
  const n = num(x);
  return n == null ? null : effect === 'Credit' ? -Math.abs(n) : Math.abs(n);
};

// ---------- symbols ----------

/** Our compact OCC symbol -> tastytrade's padded form ("NVDA261218C00185000" -> "NVDA  261218C00185000"). Tickers pass through. */
export function toTastySymbol(sym: string): string {
  const p = parseOcc(sym);
  if (!p) return sym.trim().toUpperCase();
  const compact = occ(p.root, p.expiry, p.right, p.strike);
  return p.root.padEnd(6, ' ') + compact.slice(p.root.length);
}

/** tastytrade's padded OCC -> our compact OCC. Anything that is not an option (a ticker) passes through uppercased. */
export function fromTastySymbol(sym: string): string {
  const p = parseOcc(sym);
  return p ? occ(p.root, p.expiry, p.right, p.strike) : sym.trim().toUpperCase();
}

// UNVERIFIED (from memory of tastytrade/dxFeed): the equity-option streamer symbol is
// ".ROOTyymmdd{C|P}strike" with the strike in plain decimal (".NVDA261218C185", ".SPY261218P412.5").
// The docs say to use the `streamer-symbol` field from instrument/chain responses rather than build
// it; the chain endpoint's call-streamer-symbol / put-streamer-symbol win wherever we have them.
export function toStreamerSymbol(sym: string): string {
  const p = parseOcc(sym);
  if (!p) return sym.trim().toUpperCase();
  return `.${p.root}${p.expiry.slice(2).replace(/-/g, '')}${p.right}${p.strike}`;
}

/** Streamer symbol -> compact OCC; a plain ticker passes through uppercased. */
export function fromStreamerSymbol(sym: string): string {
  const m = /^\.([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$/.exec(sym.trim().toUpperCase());
  if (!m) return sym.trim().toUpperCase();
  return occ(m[1]!, `20${m[2]}-${m[3]}-${m[4]}`, m[5] as 'C' | 'P', Number(m[6]));
}

// ---------- orders ----------

const ACTION: Record<OrderSide, string> = {
  buy: 'Buy',
  sell: 'Sell',
  buy_to_open: 'Buy to Open',
  sell_to_open: 'Sell to Open',
  buy_to_close: 'Buy to Close',
  sell_to_close: 'Sell to Close',
};
const SIDE: Record<string, OrderSide> = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k as OrderSide]));

const STATE: Record<string, OrderState> = {
  Received: 'pending',
  Routed: 'pending',
  'In Flight': 'pending',
  Contingent: 'pending',
  Live: 'open',
  'Cancel Requested': 'open',
  'Replace Requested': 'open',
  Filled: 'filled',
  Cancelled: 'canceled',
  Rejected: 'rejected',
  Expired: 'expired',
  Removed: 'canceled',
  'Partially Removed': 'canceled',
};

/** Order JSON body for an OrderRequest (dry-run and submit take the same body). Exported for tests. */
export function tastytradeOrderJson(o: OrderRequest): Json {
  validateOrder(o);
  const legs = o.legs.map((l) => {
    const isOption = parseOcc(l.symbol) != null;
    const optionAction = l.side.endsWith('_open') || l.side.endsWith('_close');
    if (isOption && !optionAction)
      throw new Error(`option leg ${l.symbol} must be opened or closed, not plain buy/sell`);
    if (!isOption && optionAction) throw new Error('a stock leg is bought or sold, not opened or closed');
    return {
      'instrument-type': isOption ? 'Equity Option' : 'Equity',
      symbol: toTastySymbol(l.symbol),
      quantity: l.quantity,
      action: ACTION[l.side],
    };
  });
  const body: Json = { 'time-in-force': o.duration === 'gtc' ? 'GTC' : 'Day', legs };
  if (o.type === 'market') {
    body['order-type'] = 'Market';
  } else {
    body['order-type'] = 'Limit';
    // UNVERIFIED: an "even" spread is sent as a zero-priced Limit; the docs show no example of it.
    body.price = (o.type === 'even' ? 0 : o.price!).toFixed(2);
    body['price-effect'] =
      o.type === 'credit'
        ? 'Credit'
        : o.type === 'debit' || o.type === 'even'
          ? 'Debit'
          : /^sell/.test(o.legs[0]!.side)
            ? 'Credit'
            : 'Debit';
  }
  if (o.tag) body['external-identifier'] = o.tag;
  return body;
}

/** Net dollars a priced order moves: positive = you pay. Null for market orders. */
function requestCost(o: OrderRequest): number | null {
  if (o.type === 'market') return null;
  if (o.type === 'even') return 0;
  const perShare = o.price!;
  const mult = o.legs.some((l) => parseOcc(l.symbol)) ? 100 : 1;
  const qty = o.legs[0]!.quantity;
  const credit = o.type === 'credit' || (o.type === 'limit' && /^sell/.test(o.legs[0]!.side));
  return round((credit ? -1 : 1) * perShare * mult * qty, 2);
}

// ---------- adapter ----------

export interface ChainStrike {
  strike: number;
  /** Compact OCC symbols. */
  call: string;
  put: string;
  callStreamer: string;
  putStreamer: string;
}

export interface TastytradeBroker extends Broker {
  /** Strike ladder (symbols only, no prices) for one expiry from the nested chain endpoint. */
  chainStructure(symbol: string, expiry: string): Promise<ChainStrike[]>;
}

export function tastytradeBroker(opts: TastytradeOptions): TastytradeBroker {
  const { env, auth } = opts;
  const now = opts.now ?? Date.now;
  const host = env === 'sandbox' ? TASTYTRADE_HOSTS.sandbox : TASTYTRADE_HOSTS.live;
  const base = `https://${host}`;
  const allowLive = opts.allowLiveOrders === true;
  const userAgent = opts.userAgent ?? 'strikebench/1.0';
  const info: SourceInfo = {
    id: 'tastytrade',
    label: env === 'sandbox' ? 'tastytrade sandbox' : 'tastytrade',
    delayMinutes: 0,
  };

  const whyOf = (body: unknown, text: string): string => {
    const b = body as Json | null;
    const e = b?.error;
    const parts: string[] = [];
    if (typeof e === 'string') {
      parts.push(e);
      if (typeof b?.error_description === 'string') parts.push(b.error_description);
    } else if (e) {
      if (e.message) parts.push(String(e.message));
      for (const x of arr<Json>(e.errors))
        if (x?.message && !parts.includes(String(x.message))) parts.push(String(x.message));
    }
    return parts.length ? parts.join('; ') : text ? text.slice(0, 200) : 'no details';
  };

  async function send(method: string, url: string, headers: Record<string, string>, payload?: unknown) {
    const res = await opts.fetch(url, {
      method,
      headers: { 'User-Agent': userAgent, Accept: 'application/json', ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // error-ok: an error page may not be JSON; the raw text is reported in the BrokerError below
    }
    return { res, text, body };
  }

  let cached: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;
  async function accessToken(force = false): Promise<string> {
    if ('accessToken' in auth) return auth.accessToken;
    if (!force && cached && cached.expiresAt > now() + 30_000) return cached.token;
    refreshing ??= (async () => {
      // The refresh token and client secret go only in this JSON body, to this adapter's own host.
      const { res, text, body } = await send(
        'POST',
        `${base}/oauth/token`,
        { 'Content-Type': 'application/json' },
        {
          grant_type: 'refresh_token',
          refresh_token: auth.refreshToken,
          client_secret: auth.clientSecret,
          ...(auth.clientId ? { client_id: auth.clientId } : {}),
        },
      );
      const tok = (body as Json | null)?.access_token;
      if (!res.ok || typeof tok !== 'string')
        throw new BrokerError(
          `tastytrade OAuth token refresh failed (HTTP ${res.status}): ${whyOf(body, text)}. A sandbox grant only works on the sandbox host and a live grant only on live.`,
          res.status,
          body,
        );
      const ttl = num((body as Json).expires_in) ?? 900; // docs: access tokens last 15 minutes
      cached = { token: tok, expiresAt: now() + ttl * 1000 };
      return tok;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function api(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    payload?: unknown,
  ): Promise<Json> {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const run = async (force: boolean) =>
      send(
        method,
        `${base}${path}${qs}`,
        {
          Authorization: `Bearer ${await accessToken(force)}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        payload,
      );
    let r = await run(false);
    // Access tokens expire after 15 minutes: one refresh-and-retry on 401 when we can refresh.
    if (r.res.status === 401 && 'refreshToken' in auth) r = await run(true);
    if (!r.res.ok)
      throw new BrokerError(
        `tastytrade ${method} ${path} failed (HTTP ${r.res.status}): ${whyOf(r.body, r.text)}`,
        r.res.status,
        r.body,
      );
    return r.body as Json;
  }

  const guardLive = (action: string) => {
    if (env === 'live' && !allowLive) throw new LiveTradingDisabledError('tastytrade', action);
  };
  const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;

  const toOrder = (o: Json): OrderStatus => {
    const legsRaw = arr<Json>(o.legs);
    const legs: OrderLeg[] = legsRaw.map((l) => ({
      symbol: fromTastySymbol(String(l.symbol)),
      side: SIDE[String(l.action)] ?? 'buy',
      quantity: Number(l.quantity),
    }));
    const fillsOf = (l: Json) => arr<Json>(l.fills);
    const first = legsRaw[0];
    const filledQuantity = first ? fillsOf(first).reduce((s, f) => s + (num(f.quantity) ?? 0), 0) : 0;
    let avg: number | null = null;
    if (filledQuantity > 0) {
      // Net per-spread price assuming 1:1 leg ratios (the common case): buys count +, sells -.
      const net = legsRaw.reduce(
        (s, l) =>
          s +
          (/^Buy/.test(String(l.action)) ? 1 : -1) *
            fillsOf(l).reduce((t, f) => t + (num(f['fill-price']) ?? 0) * (num(f.quantity) ?? 0), 0),
        0,
      );
      avg = round(Math.abs(net) / filledQuantity, 4);
    }
    const price = num(o.price);
    const type =
      o['order-type'] === 'Market'
        ? 'market'
        : legs.length > 1
          ? price === 0
            ? 'even'
            : o['price-effect'] === 'Credit'
              ? 'credit'
              : 'debit'
          : 'limit';
    let state = STATE[String(o.status)] ?? 'pending';
    if (state === 'open' && filledQuantity > 0) state = 'partially_filled';
    return {
      id: String(o.id),
      state,
      underlying: String(o['underlying-symbol'] ?? ''),
      legs,
      type,
      price,
      duration: o['time-in-force'] === 'GTC' ? 'gtc' : 'day',
      createdAt: o['received-at'] ?? null,
      filledQuantity,
      avgFillPrice: avg,
      tag: o['external-identifier'] ?? null,
    };
  };

  async function nested(sym: string): Promise<Json> {
    const items = arr<Json>(
      (await api('GET', `/option-chains/${encodeURIComponent(sym.toUpperCase())}/nested`)).data?.items,
    );
    const chain = items.find((c) => c['root-symbol'] === sym.toUpperCase()) ?? items[0];
    if (!chain) throw new Error(`tastytrade lists no option chain for ${sym.toUpperCase()}`);
    return chain;
  }

  // The REST side has no usable quote (sandbox /market-data answers 502), and a chain row without
  // bid/ask would win the ladder as "no market". So this rung serves expirations only; quotes and
  // chain prices fall through to the next source. The strike ladder is exposed as chainStructure().
  const md: MarketDataSource = {
    ...info,
    async expirations(sym) {
      const chain = await nested(sym);
      const d = arr<Json>(chain.expirations)
        .map((e) => String(e['expiration-date']))
        .filter(Boolean);
      if (!d.length) throw new Error(`tastytrade lists no option expirations for ${sym.toUpperCase()}`);
      return { symbol: sym, expirations: [...new Set(d)].sort(), ...tag(info, now()) };
    },
  };

  const streamerFor = new Map<string, string>(); // compact OCC -> the broker's streamer symbol

  return {
    id: 'tastytrade',
    label: info.label,
    env,
    liveOrdersAllowed: env === 'live' && allowLive,
    capabilities: TASTYTRADE_CAPABILITIES,
    hosts: [host],

    async accounts() {
      const items = arr<Json>((await api('GET', '/customers/me/accounts')).data?.items);
      return items.map((i): BrokerAccount => {
        const a = (i.account ?? {}) as Json;
        return {
          id: String(a['account-number']),
          type: String(a['margin-or-cash'] ?? a['account-type-name'] ?? 'unknown').toLowerCase(),
          // UNVERIFIED: suitable-options-level is a text label, not a number; no documented mapping.
          optionLevel: num(a['suitable-options-level']),
          status: a['is-closed'] === true ? 'closed' : 'active',
        };
      });
    },

    async balances(accountId) {
      const b = (await api('GET', `${acct(accountId)}/balances`)).data ?? {};
      return {
        accountId,
        equity: num(b['net-liquidating-value']) ?? 0,
        cash: num(b['cash-balance']) ?? 0,
        optionBuyingPower: num(b['derivative-buying-power']),
        stockBuyingPower: num(b['equity-buying-power']),
        openPnl: null, // the balances object carries no open P/L
      } satisfies Balances;
    },

    async positions(accountId) {
      const items = arr<Json>((await api('GET', `${acct(accountId)}/positions`)).data?.items);
      const out: BrokerPosition[] = [];
      for (const x of items) {
        const type = x['instrument-type'];
        if (type !== 'Equity' && type !== 'Equity Option') continue; // futures / crypto are out of scope
        const short = x['quantity-direction'] === 'Short';
        const q = (num(x.quantity) ?? 0) * (short ? -1 : 1);
        const mult = num(x.multiplier) ?? (type === 'Equity Option' ? 100 : 1);
        const costBasis = round((num(x['average-open-price']) ?? 0) * q * mult, 2);
        const acquired = typeof x['created-at'] === 'string' ? x['created-at'].slice(0, 10) : null;
        if (type === 'Equity Option') {
          const o = parseOcc(String(x.symbol));
          if (!o) continue;
          out.push({
            symbol: occ(o.root, o.expiry, o.right, o.strike),
            underlying: String(x['underlying-symbol'] ?? o.root),
            kind: 'option',
            quantity: q,
            costBasis,
            expiry: o.expiry,
            strike: o.strike,
            right: o.right,
            acquired,
          });
        } else {
          out.push({
            symbol: String(x.symbol),
            underlying: String(x.symbol),
            kind: 'stock',
            quantity: q,
            costBasis,
            acquired,
          });
        }
      }
      return out;
    },

    async orders(accountId) {
      // UNVERIFIED: /orders/live ("Today's Orders") is assumed to include today's terminal orders
      // (filled / cancelled) as well as working ones; the sandbox check confirms it.
      return arr<Json>((await api('GET', `${acct(accountId)}/orders/live`)).data?.items).map(toOrder);
    },

    async previewOrder(accountId, order) {
      const res = await api('POST', `${acct(accountId)}/orders/dry-run`, undefined, tastytradeOrderJson(order));
      const d = (res.data ?? {}) as Json;
      const fee = (d['fee-calculation'] ?? {}) as Json;
      const bpe = (d['buying-power-effect'] ?? {}) as Json;
      const errors = arr<Json>(d.errors);
      const commission = signed(fee.commission, fee['commission-effect']);
      const totalFees = signed(fee['total-fees'], fee['total-fees-effect']);
      const orderCost = d.order ? signed(d.order.value, d.order['value-effect']) : null;
      return {
        ok: errors.length === 0,
        cost: orderCost ?? requestCost(order),
        commission,
        fees: totalFees != null && commission != null ? round(totalFees - commission, 4) : totalFees,
        marginChange: signed(bpe['change-in-margin-requirement'], bpe['change-in-margin-requirement-effect']),
        warnings: [...errors, ...arr<Json>(d.warnings)].map((w) => String(w.message ?? w.code ?? '')).filter(Boolean),
        raw: res,
      } satisfies OrderPreview;
    },

    async placeOrder(accountId, order) {
      const body = tastytradeOrderJson(order); // validate before the live check so both run with no request sent
      guardLive('Order');
      const res = await api('POST', `${acct(accountId)}/orders`, undefined, body);
      const o = ((res.data as Json | undefined)?.order ?? {}) as Json;
      if (o.id == null)
        throw new BrokerError(`tastytrade did not accept the order: ${JSON.stringify(res).slice(0, 300)}`, 200, res);
      return { id: String(o.id), state: STATE[String(o.status)] ?? 'pending', raw: res } satisfies PlacedOrder;
    },

    async cancelOrder(accountId, orderId) {
      guardLive('Cancel');
      const res = await api('DELETE', `${acct(accountId)}/orders/${encodeURIComponent(orderId)}`);
      const o = (res.data ?? {}) as Json;
      // UNVERIFIED: the cancel response is assumed to be the order with status Cancel Requested or Cancelled.
      return {
        id: String(o.id ?? orderId),
        ok: ['Cancel Requested', 'Cancelled', 'Removed'].includes(String(o.status)),
        raw: res,
      };
    },

    marketData: () => md,

    async chainStructure(symbol, expiry) {
      const chain = await nested(symbol);
      const e = arr<Json>(chain.expirations).find((x) => x['expiration-date'] === expiry);
      if (!e) throw new Error(`tastytrade has no ${symbol.toUpperCase()} expiry ${expiry}`);
      const rows = arr<Json>(e.strikes)
        .map((s): ChainStrike => ({
          strike: Number(s['strike-price']),
          call: fromTastySymbol(String(s.call)),
          put: fromTastySymbol(String(s.put)),
          callStreamer: String(s['call-streamer-symbol']),
          putStreamer: String(s['put-streamer-symbol']),
        }))
        .sort((a, b) => a.strike - b.strike);
      // Remember the broker's own streamer symbols so stream() uses them instead of a derived guess.
      for (const r of rows) {
        streamerFor.set(r.call, r.callStreamer);
        streamerFor.set(r.put, r.putStreamer);
      }
      return rows;
    },

    async stream(symbols, onQuote, onError) {
      const WS = opts.WebSocket;
      if (!WS)
        throw new Error(
          'tastytrade quotes stream over DXLink (a websocket) and no WebSocket implementation was supplied; ' +
            'pass `WebSocket` (the global one in browsers and Node 22+) or use another market-data source.',
        );
      const tok = ((await api('GET', '/api-quote-tokens')).data ?? {}) as Json;
      const url = String(tok['dxlink-url'] ?? '');
      let u: URL | null = null;
      try {
        u = new URL(url);
      } catch {
        // error-ok: an unparsable URL is rejected with an explicit error right below
      }
      if (!u || u.protocol !== 'wss:' || !TASTYTRADE_HOSTS.dxlinkSuffixes.some((s) => u.hostname.endsWith(s)))
        throw new Error(
          `tastytrade returned an unexpected DXLink URL (${url.slice(0, 80)}); refusing to send the quote token there`,
        );
      if (typeof tok.token !== 'string') throw new Error('tastytrade returned no API quote token');

      const subs = new Map<string, string>(); // streamer symbol -> caller symbol
      for (const s of symbols) subs.set(streamerFor.get(s) ?? toStreamerSymbol(s), s);
      const CH = 3;
      const QUOTE = ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'];
      const TRADE = ['eventType', 'eventSymbol', 'price'];
      const last = new Map<string, StreamQuote>();
      const ws = new WS(url);
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const fail = (m: string) => onError?.(new Error(m));
      const out = (o: Json) => ws.send(JSON.stringify(o));
      const feed = (type: string, rows: unknown[], fields: string[]) => {
        for (let i = 0; i + fields.length <= rows.length; i += fields.length) {
          const v = rows.slice(i, i + fields.length);
          const caller = subs.get(String(v[1]));
          if (!caller) continue;
          const prev = last.get(caller) ?? { symbol: caller, bid: null, ask: null, last: null, at: 0 };
          const next: StreamQuote =
            type === 'Quote'
              ? { ...prev, bid: num(v[2]), ask: num(v[3]), at: now() }
              : { ...prev, last: num(v[2]), at: now() };
          last.set(caller, next);
          onQuote(next);
        }
      };
      ws.onopen = () =>
        out({
          type: 'SETUP',
          channel: 0,
          version: '0.1-DXF-JS/0.3.0',
          keepaliveTimeout: 60,
          acceptKeepaliveTimeout: 60,
        });
      ws.onmessage = (ev) => {
        let m: Json;
        try {
          m = JSON.parse(String(ev.data));
        } catch (e) {
          fail(
            `tastytrade stream sent a frame that is not JSON: ${String(ev.data).slice(0, 80)} (${(e as Error).message})`,
          );
          return;
        }
        switch (m.type) {
          case 'AUTH_STATE':
            if (m.state === 'UNAUTHORIZED') out({ type: 'AUTH', channel: 0, token: tok.token });
            else if (m.state === 'AUTHORIZED')
              out({ type: 'CHANNEL_REQUEST', channel: CH, service: 'FEED', parameters: { contract: 'AUTO' } });
            break;
          case 'CHANNEL_OPENED':
            out({
              type: 'FEED_SETUP',
              channel: CH,
              acceptAggregationPeriod: 0.1,
              acceptDataFormat: 'COMPACT',
              acceptEventFields: { Quote: QUOTE, Trade: TRADE },
            });
            break;
          case 'FEED_CONFIG':
            out({
              type: 'FEED_SUBSCRIPTION',
              channel: CH,
              reset: true,
              add: [...subs.keys()].flatMap((symbol) => [
                { type: 'Quote', symbol },
                { type: 'Trade', symbol },
              ]),
            });
            keepalive ??= setInterval(() => out({ type: 'KEEPALIVE', channel: 0 }), 30_000);
            break;
          case 'FEED_DATA': {
            // COMPACT: ["Quote", [type, symbol, bid, ask, type, symbol, ...], "Trade", [...]]
            const d = arr<unknown>(m.data);
            for (let i = 0; i + 1 < d.length; i += 2) {
              const type = String(d[i]);
              const rows = arr<unknown>(d[i + 1]);
              if (type === 'Quote') feed(type, rows, QUOTE);
              else if (type === 'Trade') feed(type, rows, TRADE);
            }
            break;
          }
          case 'ERROR':
            fail(`tastytrade DXLink error ${m.error ?? ''}: ${m.message ?? ''}`);
            break;
          default:
            break; // SETUP echo, KEEPALIVE, ...
        }
      };
      ws.onerror = () => fail('tastytrade stream connection error');
      ws.onclose = () => clearInterval(keepalive);
      return () => {
        clearInterval(keepalive);
        ws.close();
      };
    },
  };
}
