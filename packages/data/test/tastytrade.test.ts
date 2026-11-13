// Contract tests for the tastytrade adapter. Two kinds of fixture in fixtures/tastytrade/: hand-built ones
// (see each file's "_provenance"; they cover fills, positions and several accounts that a fresh sandbox
// account cannot produce) and sandbox-recording.json, responses RECORDED from the cert sandbox by
// scripts/tastytrade-sandbox.ts --record, replayed at the bottom of this file.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  fromStreamerSymbol,
  fromTastySymbol,
  tastytradeBroker,
  tastytradeOrderJson,
  toStreamerSymbol,
  toTastySymbol,
  TASTYTRADE_HOSTS,
} from '../src/broker/tastytrade.ts';
import type { TastytradeOptions } from '../src/broker/tastytrade.ts';
import type { SocketLike } from '../src/broker/tradier.ts';
import { BrokerError, LiveTradingDisabledError } from '../src/broker/types.ts';
import type { FetchLike, OrderRequest, StreamQuote } from '../src/broker/types.ts';
import { occ, parseOcc } from '../src/symbols.ts';
import { brokerEntry, createBroker } from '../src/broker/registry.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const fx = (name: string): Json =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/tastytrade/${name}.json`, import.meta.url), 'utf8'));

const ACCT = '5WX01234';
const ACCESS = 'access-token-not-real';
const REFRESH = 'refresh-token-not-real';
const SECRET = 'client-secret-not-real';
const C1 = 'NVDA261218C00185000';
const C2 = 'NVDA261218C00200000';

type Req = { method: string; url: string; headers: Record<string, string>; body?: string };
/** Routes `METHOD /path` to a fixture (or a function / [status, body]) and records every request. */
function router(routes: Record<string, Json | ((req: Req) => Json) | [number, Json]>) {
  const requests: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const req: Req = { method, url, headers: init?.headers ?? {}, body: init?.body };
    requests.push(req);
    const key = `${method} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) throw new Error(`no route for ${key}`);
    const [status, body] = Array.isArray(r) ? r : [200, typeof r === 'function' ? r(req) : r];
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}

const STD_ROUTES = {
  'GET /customers/me/accounts': fx('accounts'),
  [`GET /accounts/${ACCT}/balances`]: fx('balances'),
  [`GET /accounts/${ACCT}/positions`]: fx('positions'),
  [`GET /accounts/${ACCT}/orders/live`]: fx('orders-live'),
  [`POST /accounts/${ACCT}/orders/dry-run`]: fx('dry-run-debit'),
  [`POST /accounts/${ACCT}/orders`]: fx('order-placed'),
  [`DELETE /accounts/${ACCT}/orders/771043`]: fx('order-cancel-requested'),
  'GET /option-chains/NVDA/nested': fx('nested-chain'),
  'GET /api-quote-tokens': fx('quote-token'),
};

const make = (fetch: FetchLike, o: Partial<TastytradeOptions> = {}) =>
  tastytradeBroker({ auth: { accessToken: ACCESS }, env: 'sandbox', fetch, ...o });

const debit: OrderRequest = {
  underlying: 'NVDA',
  type: 'debit',
  price: 1.2,
  duration: 'day',
  tag: 'strikecraft-sandbox-check',
  legs: [
    { symbol: C1, side: 'buy_to_open', quantity: 1 },
    { symbol: C2, side: 'sell_to_open', quantity: 1 },
  ],
};
const credit: OrderRequest = {
  underlying: 'NVDA',
  type: 'credit',
  price: 1.1,
  duration: 'gtc',
  legs: [
    { symbol: C1, side: 'sell_to_open', quantity: 2 },
    { symbol: C2, side: 'buy_to_open', quantity: 2 },
  ],
};

describe('tastytrade symbols', () => {
  it('converts compact OCC <-> tastytrade padded OCC', () => {
    expect(toTastySymbol(C1)).toBe('NVDA  261218C00185000');
    expect(toTastySymbol('SPY261218P00412500')).toBe('SPY   261218P00412500');
    expect(toTastySymbol('GOOGL261218C00150000')).toBe('GOOGL 261218C00150000');
    expect(toTastySymbol('nvda')).toBe('NVDA');
    expect(fromTastySymbol('NVDA  261218C00185000')).toBe(C1);
    expect(fromTastySymbol('nvda')).toBe('NVDA');
  });

  it('round-trips every shape both ways', () => {
    for (const s of [
      C1,
      occ('SPY', '2027-01-15', 'P', 412.5),
      occ('F', '2026-12-18', 'C', 0.5),
      occ('GOOGL', '2026-12-18', 'C', 1050.55),
    ]) {
      expect(fromTastySymbol(toTastySymbol(s))).toBe(s);
      expect(fromStreamerSymbol(toStreamerSymbol(s))).toBe(s);
      const p = parseOcc(toTastySymbol(s))!;
      expect(occ(p.root, p.expiry, p.right, p.strike)).toBe(s);
    }
    expect(toStreamerSymbol(occ('SPY', '2027-01-15', 'P', 412.5))).toBe('.SPY270115P412.5');
    expect(toStreamerSymbol('NVDA')).toBe('NVDA');
    expect(fromStreamerSymbol('.NVDA261218C185')).toBe(C1);
    expect(fromStreamerSymbol('NVDA')).toBe('NVDA');
  });
});

describe('tastytrade reads', () => {
  it('maps accounts, balances and positions', async () => {
    const { fetch } = router(STD_ROUTES);
    const b = make(fetch);
    expect(await b.accounts()).toEqual([
      { id: ACCT, type: 'margin', optionLevel: null, status: 'active' },
      { id: '5WX09999', type: 'cash', optionLevel: null, status: 'closed' },
    ]);
    expect(await b.balances(ACCT)).toEqual({
      accountId: ACCT,
      equity: 10450.25,
      cash: 10000,
      optionBuyingPower: 9000.5,
      stockBuyingPower: 20000,
      openPnl: null,
    });
    const pos = await b.positions(ACCT);
    expect(pos).toHaveLength(3); // the future is out of scope
    expect(pos[0]).toMatchObject({
      symbol: 'NVDA',
      kind: 'stock',
      quantity: 100,
      costBasis: 15025,
      acquired: '2026-11-02',
    });
    expect(pos[1]).toEqual({
      symbol: C1,
      underlying: 'NVDA',
      kind: 'option',
      quantity: -2,
      costBasis: -820,
      expiry: '2026-12-18',
      strike: 185,
      right: 'C',
      acquired: '2026-11-03',
    });
    expect(pos[2]).toMatchObject({ symbol: C2, quantity: 2, costBasis: 300, strike: 200 });
  });

  it('lists orders: states, spread type, fills and tag', async () => {
    const { fetch } = router(STD_ROUTES);
    const o = await make(fetch).orders(ACCT);
    expect(o.map((x) => x.state)).toEqual(['open', 'filled', 'canceled', 'partially_filled']);
    expect(o[0]).toMatchObject({
      id: '771043',
      underlying: 'NVDA',
      type: 'debit',
      price: 0.01,
      duration: 'day',
      tag: 'strikecraft-sandbox-check',
      createdAt: '2026-11-13T18:26:52.513+00:00',
    });
    expect(o[0]!.legs).toEqual(debit.legs.map((l) => ({ ...l })));
    // Filled credit spread: sold 4.00, bought 2.80 -> 1.20 net credit on 2 contracts.
    expect(o[1]).toMatchObject({ type: 'credit', duration: 'gtc', filledQuantity: 2, avgFillPrice: 1.2 });
    expect(o[1]!.legs.map((l) => l.side)).toEqual(['sell_to_close', 'buy_to_close']);
    expect(o[2]).toMatchObject({ type: 'market', price: null });
    expect(o[3]).toMatchObject({ type: 'limit', filledQuantity: 4, avgFillPrice: 150 });
  });
});

describe('tastytrade orders', () => {
  it('builds single-leg, debit and credit order JSON', () => {
    expect(
      tastytradeOrderJson({
        underlying: 'NVDA',
        type: 'limit',
        price: 4.7,
        duration: 'gtc',
        legs: [{ symbol: C1, side: 'sell_to_close', quantity: 2 }],
      }),
    ).toEqual({
      'time-in-force': 'GTC',
      'order-type': 'Limit',
      price: '4.70',
      'price-effect': 'Credit',
      legs: [
        { 'instrument-type': 'Equity Option', symbol: 'NVDA  261218C00185000', quantity: 2, action: 'Sell to Close' },
      ],
    });
    expect(
      tastytradeOrderJson({
        underlying: 'NVDA',
        type: 'market',
        duration: 'day',
        legs: [{ symbol: 'NVDA', side: 'buy', quantity: 10 }],
      }),
    ).toEqual({
      'time-in-force': 'Day',
      'order-type': 'Market',
      legs: [{ 'instrument-type': 'Equity', symbol: 'NVDA', quantity: 10, action: 'Buy' }],
    });
    expect(tastytradeOrderJson(debit)).toEqual({
      'time-in-force': 'Day',
      'order-type': 'Limit',
      price: '1.20',
      'price-effect': 'Debit',
      'external-identifier': 'strikecraft-sandbox-check',
      legs: [
        { 'instrument-type': 'Equity Option', symbol: 'NVDA  261218C00185000', quantity: 1, action: 'Buy to Open' },
        { 'instrument-type': 'Equity Option', symbol: 'NVDA  261218C00200000', quantity: 1, action: 'Sell to Open' },
      ],
    });
    const c = tastytradeOrderJson(credit);
    expect(c).toMatchObject({ 'time-in-force': 'GTC', price: '1.10', 'price-effect': 'Credit' });
    expect(c.legs.map((l: Json) => l.action)).toEqual(['Sell to Open', 'Buy to Open']);
  });

  it('rejects an option leg without open/close and a stock leg with it', () => {
    expect(() =>
      tastytradeOrderJson({
        underlying: 'NVDA',
        type: 'market',
        duration: 'day',
        legs: [{ symbol: C1, side: 'buy', quantity: 1 }],
      }),
    ).toThrow('opened or closed');
    expect(() =>
      tastytradeOrderJson({
        underlying: 'NVDA',
        type: 'market',
        duration: 'day',
        legs: [{ symbol: 'NVDA', side: 'buy_to_open', quantity: 1 }],
      }),
    ).toThrow('stock leg');
    expect(() => tastytradeOrderJson({ ...debit, legs: [] })).toThrow('at least one leg');
  });

  it('dry-run previews without placing; place and cancel use their own endpoints', async () => {
    const { fetch, requests } = router(STD_ROUTES);
    const b = make(fetch);
    const p = await b.previewOrder(ACCT, debit);
    expect(requests.at(-1)).toMatchObject({ method: 'POST' });
    expect(requests.at(-1)!.url).toBe(`https://api.cert.tastyworks.com/accounts/${ACCT}/orders/dry-run`);
    expect(JSON.parse(requests.at(-1)!.body!)).toEqual(tastytradeOrderJson(debit));
    expect(p).toMatchObject({ ok: true, cost: 120, commission: 2, marginChange: 300 });
    expect(p.fees).toBeCloseTo(0.302, 6);
    expect(p.warnings).toEqual(['Your order will begin working during next valid session.']);
    expect(requests.some((r) => r.url.endsWith('/orders'))).toBe(false);

    const placed = await b.placeOrder(ACCT, debit);
    expect(placed).toMatchObject({ id: '771043', state: 'pending' });
    expect(requests.at(-1)!.url).toBe(`https://api.cert.tastyworks.com/accounts/${ACCT}/orders`);

    const cancel = await b.cancelOrder(ACCT, '771043');
    expect(cancel).toMatchObject({ id: '771043', ok: true });
    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `https://api.cert.tastyworks.com/accounts/${ACCT}/orders/771043`,
    });
  });

  it('prices a credit preview as cash received', async () => {
    const { fetch } = router({ ...STD_ROUTES, [`POST /accounts/${ACCT}/orders/dry-run`]: { data: { warnings: [] } } });
    const p = await make(fetch).previewOrder(ACCT, credit);
    expect(p.cost).toBe(-220); // 1.10 x 100 x 2 contracts received
    expect(p.ok).toBe(true);
  });

  it('surfaces the broker message on an API error', async () => {
    const { fetch } = router({ ...STD_ROUTES, [`POST /accounts/${ACCT}/orders/dry-run`]: [422, fx('error-422')] });
    const err = await make(fetch)
      .previewOrder(ACCT, debit)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.status).toBe(422);
    expect(err.message).toBe(
      `tastytrade POST /accounts/${ACCT}/orders/dry-run failed (HTTP 422): Order preflight check failed; You cannot buy for a credit.; Insufficient buying power.`,
    );
  });
});

describe('tastytrade live-trading guard', () => {
  it('refuses to place or cancel on a live account before any request is made', async () => {
    const { fetch, requests } = router({});
    const live = make(fetch, { env: 'live' });
    expect(live.liveOrdersAllowed).toBe(false);
    await expect(live.placeOrder(ACCT, debit)).rejects.toBeInstanceOf(LiveTradingDisabledError);
    await expect(live.cancelOrder(ACCT, '1')).rejects.toBeInstanceOf(LiveTradingDisabledError);
    expect(requests).toHaveLength(0);
  });

  it('a live preview is allowed and goes to the live host; place works only with the explicit flag', async () => {
    const { fetch, requests } = router(STD_ROUTES);
    const live = make(fetch, { env: 'live' });
    await live.previewOrder(ACCT, debit);
    expect(new URL(requests[0]!.url).host).toBe('api.tastyworks.com');
    const allowed = make(fetch, { env: 'live', allowLiveOrders: true });
    expect(allowed.liveOrdersAllowed).toBe(true);
    expect((await allowed.placeOrder(ACCT, debit)).id).toBe('771043');
    expect(make(fetch, { env: 'sandbox', allowLiveOrders: true }).liveOrdersAllowed).toBe(false);
  });
});

describe('tastytrade credentials', () => {
  it('sends a ready access token only to the cert host, as a bearer header, never in a URL or body', async () => {
    const { fetch, requests } = router(STD_ROUTES);
    const b = make(fetch);
    await b.accounts();
    await b.balances(ACCT);
    await b.previewOrder(ACCT, debit);
    await b.marketData().expirations!('NVDA');
    expect(b.hosts).toEqual([TASTYTRADE_HOSTS.sandbox]);
    expect(requests.length).toBe(4);
    for (const r of requests) {
      expect(new URL(r.url).host).toBe('api.cert.tastyworks.com');
      expect(new URL(r.url).protocol).toBe('https:');
      expect(r.headers.Authorization).toBe(`Bearer ${ACCESS}`);
      expect(r.headers['User-Agent']).toMatch(/^[\w-]+\/[\w.]+$/);
      expect(r.url).not.toContain(ACCESS);
      expect(r.body ?? '').not.toContain(ACCESS);
    }
  });

  it('exchanges the refresh token on the env host, once, and keeps the secrets out of URLs and later calls', async () => {
    const { fetch, requests } = router({ ...STD_ROUTES, 'POST /oauth/token': fx('oauth-token') });
    let t = 1_000_000;
    const b = make(fetch, { auth: { refreshToken: REFRESH, clientSecret: SECRET, clientId: 'cid' }, now: () => t });
    await b.accounts();
    await b.balances(ACCT);
    const tokenReqs = requests.filter((r) => r.url.endsWith('/oauth/token'));
    expect(tokenReqs).toHaveLength(1);
    expect(tokenReqs[0]!.url).toBe('https://api.cert.tastyworks.com/oauth/token');
    expect(JSON.parse(tokenReqs[0]!.body!)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_secret: SECRET,
      client_id: 'cid',
    });
    for (const r of requests) {
      expect(new URL(r.url).host).toBe('api.cert.tastyworks.com');
      expect(r.url).not.toMatch(new RegExp(`${REFRESH}|${SECRET}`));
      if (r !== tokenReqs[0])
        expect(`${r.body ?? ''}${JSON.stringify(r.headers)}`).not.toMatch(new RegExp(`${REFRESH}|${SECRET}`));
      if (r !== tokenReqs[0]) expect(r.headers.Authorization).toBe('Bearer fixture-access-token');
    }
    t += 16 * 60_000; // the 15-minute token has expired: a new exchange happens
    await b.accounts();
    expect(requests.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(2);
  });

  it('refreshes and retries once on a 401', async () => {
    let first = true;
    const { fetch, requests } = router({ ...STD_ROUTES, 'POST /oauth/token': fx('oauth-token') });
    const flaky: FetchLike = async (url, init) => {
      if (first && new URL(url).pathname === '/customers/me/accounts') {
        first = false;
        const body = JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } });
        return { ok: false, status: 401, text: async () => body };
      }
      return fetch(url, init);
    };
    const b = make(flaky, { auth: { refreshToken: REFRESH, clientSecret: SECRET } });
    expect(await b.accounts()).toHaveLength(2);
    expect(requests.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(2);
  });

  it('reports a failed token exchange without echoing the secrets', async () => {
    const { fetch } = router({
      'POST /oauth/token': [400, { error: 'invalid_grant', error_description: 'refresh token is invalid' }],
    });
    const b = make(fetch, { env: 'live', auth: { refreshToken: REFRESH, clientSecret: SECRET } });
    const err = await b.accounts().catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.message).toContain('invalid_grant; refresh token is invalid');
    expect(err.message).not.toMatch(new RegExp(`${REFRESH}|${SECRET}`));
  });
});

describe('tastytrade market data', () => {
  it('serves expirations from the nested chain and leaves quote and optionChain to the next rung', async () => {
    const { fetch } = router(STD_ROUTES);
    const md = make(fetch).marketData();
    expect(md).toMatchObject({ id: 'tastytrade', label: 'tastytrade sandbox' });
    expect(md.quote).toBeUndefined();
    expect(md.optionChain).toBeUndefined();
    const e = await md.expirations!('nvda');
    expect(e).toMatchObject({ symbol: 'nvda', expirations: ['2026-12-18', '2027-01-15'], source: 'tastytrade' });
  });

  it('exposes the strike ladder with compact OCC symbols', async () => {
    const { fetch } = router(STD_ROUTES);
    const s = await make(fetch).chainStructure('NVDA', '2026-12-18');
    expect(s.map((x) => x.strike)).toEqual([185, 187.5, 200]);
    expect(s[0]).toEqual({
      strike: 185,
      call: C1,
      put: 'NVDA261218P00185000',
      callStreamer: '.NVDA261218C185',
      putStreamer: '.NVDA261218P185',
    });
    await expect(make(fetch).chainStructure('NVDA', '2030-01-01')).rejects.toThrow('no NVDA expiry');
  });
});

describe('tastytrade DXLink stream', () => {
  class FakeSocket implements SocketLike {
    static all: FakeSocket[] = [];
    url: string;
    sent: Json[] = [];
    closed = false;
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onerror: SocketLike['onerror'] = null;
    onclose: SocketLike['onclose'] = null;
    constructor(url: string) {
      this.url = url;
      FakeSocket.all.push(this);
    }
    send(d: string) {
      this.sent.push(JSON.parse(d));
    }
    close() {
      this.closed = true;
    }
    recv(m: Json) {
      this.onmessage!({ data: JSON.stringify(m) });
    }
  }

  it('says why when there is no WebSocket', async () => {
    const { fetch, requests } = router(STD_ROUTES);
    await expect(make(fetch).stream(['NVDA'], () => {})).rejects.toThrow(/DXLink.*no WebSocket/);
    expect(requests).toHaveLength(0);
  });

  it('runs the handshake, subscribes, merges quote and trade events and stops', async () => {
    FakeSocket.all = [];
    const { fetch, requests } = router(STD_ROUTES);
    const got: StreamQuote[] = [];
    const errors: string[] = [];
    const b = make(fetch, { WebSocket: FakeSocket, now: () => 42 });
    await b.chainStructure('NVDA', '2026-12-18'); // teaches the adapter the broker's own streamer symbols
    const stop = await b.stream(
      ['NVDA', C1],
      (q) => got.push(q),
      (e) => errors.push(e.message),
    );
    expect(requests.at(-1)!.url).toBe('https://api.cert.tastyworks.com/api-quote-tokens');
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe('wss://tasty-openapi-ws.dxfeed.com/realtime');
    ws.onopen!({});
    expect(ws.sent[0]).toMatchObject({ type: 'SETUP', channel: 0 });
    ws.recv({ type: 'SETUP', channel: 0 });
    ws.recv({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' });
    expect(ws.sent[1]).toEqual({ type: 'AUTH', channel: 0, token: 'fixture-quote-token' });
    ws.recv({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' });
    expect(ws.sent[2]).toEqual({
      type: 'CHANNEL_REQUEST',
      channel: 3,
      service: 'FEED',
      parameters: { contract: 'AUTO' },
    });
    ws.recv({ type: 'CHANNEL_OPENED', channel: 3 });
    expect(ws.sent[3]).toMatchObject({ type: 'FEED_SETUP', channel: 3, acceptDataFormat: 'COMPACT' });
    ws.recv({ type: 'FEED_CONFIG', channel: 3 });
    expect(ws.sent[4]).toEqual({
      type: 'FEED_SUBSCRIPTION',
      channel: 3,
      reset: true,
      add: [
        { type: 'Quote', symbol: 'NVDA' },
        { type: 'Trade', symbol: 'NVDA' },
        { type: 'Quote', symbol: '.NVDA261218C185' },
        { type: 'Trade', symbol: '.NVDA261218C185' },
      ],
    });
    ws.recv({
      type: 'FEED_DATA',
      channel: 3,
      data: ['Quote', ['Quote', 'NVDA', 170.4, 170.45, 'Quote', '.NVDA261218C185', 'NaN', 3.1]],
    });
    ws.recv({ type: 'FEED_DATA', channel: 3, data: ['Trade', ['Trade', 'NVDA', 170.42]] });
    ws.recv({ type: 'FEED_DATA', channel: 3, data: ['Quote', ['Quote', 'OTHER', 1, 2]] });
    ws.onmessage!({ data: 'not json' });
    ws.recv({ type: 'ERROR', channel: 0, error: 'TIMEOUT', message: 'Session timed out' });
    expect(got).toEqual([
      { symbol: 'NVDA', bid: 170.4, ask: 170.45, last: null, at: 42 },
      { symbol: C1, bid: null, ask: 3.1, last: null, at: 42 },
      { symbol: 'NVDA', bid: 170.4, ask: 170.45, last: 170.42, at: 42 },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('not JSON');
    expect(errors[1]).toContain('TIMEOUT: Session timed out');
    stop();
    expect(ws.closed).toBe(true);
  });

  it('refuses to send the quote token to a host outside tastytrade / dxFeed or over ws://', async () => {
    for (const url of ['wss://evil.example.com/realtime', 'ws://tasty-openapi-ws.dxfeed.com/realtime']) {
      FakeSocket.all = [];
      const tok = fx('quote-token');
      tok.data['dxlink-url'] = url;
      const { fetch } = router({ 'GET /api-quote-tokens': tok });
      await expect(make(fetch, { WebSocket: FakeSocket }).stream(['NVDA'], () => {})).rejects.toThrow(
        'unexpected DXLink URL',
      );
      expect(FakeSocket.all).toHaveLength(0);
    }
  });
});

// ---- contract tests against responses RECORDED from the cert sandbox (fixtures/tastytrade/sandbox-recording.json)
type Exchange = { method: string; url: string; body: string | null; status: number; response: string };
const recording = (): Exchange[] =>
  (
    JSON.parse(fs.readFileSync(new URL('./fixtures/tastytrade/sandbox-recording.json', import.meta.url), 'utf8')) as {
      exchanges: Exchange[];
    }
  ).exchanges;

/** Replays the recorded exchanges: same method + path + request body, served in recorded order. */
function replay() {
  const queue = recording();
  const requests: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url, headers: init?.headers ?? {}, body: init?.body });
    const path = new URL(url).pathname;
    const i = queue.findIndex(
      (x) => x.method === method && new URL(x.url).pathname === path && (x.body == null || x.body === init?.body),
    );
    if (i < 0) throw new Error(`nothing recorded for ${method} ${path} ${init?.body ?? ''}`);
    const [x] = queue.splice(i, 1);
    return { ok: x!.status >= 200 && x!.status < 300, status: x!.status, text: async () => x!.response };
  };
  return { fetch, requests };
}
const RA = '5WA00000'; // the scrubbed account number in the recording
const VERTICAL: OrderRequest = {
  underlying: 'NVDA',
  type: 'debit',
  price: 0.01,
  duration: 'day',
  tag: 'strikecraft-sandbox-check',
  legs: [
    { symbol: 'NVDA261218C01930000', side: 'buy_to_open', quantity: 1 },
    { symbol: 'NVDA261218C01940000', side: 'sell_to_open', quantity: 1 },
  ],
};

describe('tastytrade against recorded sandbox responses', () => {
  it('reads accounts, balances, positions and the chain as the real API returns them', async () => {
    const b = make(replay().fetch);
    // "suitable-options-level" is the text "No Restrictions": no numeric level, so optionLevel stays null.
    expect(await b.accounts()).toEqual([{ id: RA, type: 'margin', optionLevel: null, status: 'active' }]);
    expect(await b.balances(RA)).toMatchObject({ equity: 100000, cash: 100000 });
    expect(await b.positions(RA)).toEqual([]);
    const strikes = await b.chainStructure('NVDA', '2026-12-18');
    expect(strikes.map((s) => s.strike)).toEqual([180, 185, 190, 195, 200, 1930, 1940]);
    // The broker's own streamer symbols are exactly what toStreamerSymbol derives from the OCC symbol.
    for (const s of strikes) {
      expect(toStreamerSymbol(s.call)).toBe(s.callStreamer);
      expect(toStreamerSymbol(s.put)).toBe(s.putStreamer);
    }
    expect(strikes[0]).toMatchObject({ call: 'NVDA261218C00180000', callStreamer: '.NVDA261218C180' });
  });

  it('dry-run, place, list and cancel a 2-leg vertical: statuses and error body as recorded', async () => {
    const { fetch } = replay();
    const b = make(fetch);
    expect(await b.previewOrder(RA, VERTICAL)).toMatchObject({ ok: true, cost: 1, commission: 2, marginChange: 1 });
    // An "even" spread (zero-priced Limit) is accepted by the sandbox dry-run.
    expect(await b.previewOrder(RA, { ...VERTICAL, type: 'even', price: undefined })).toMatchObject({ ok: true });
    const bad = await b
      .previewOrder(RA, {
        ...VERTICAL,
        legs: [{ symbol: 'NVDA261218C01931000', side: 'buy_to_open', quantity: 1 }, VERTICAL.legs[1]!],
      })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(BrokerError);
    expect((bad as BrokerError).message).toContain('Trading of NVDA  261218C01931000 is not supported');
    const placed = await b.placeOrder(RA, VERTICAL);
    expect(placed.state).toBe('pending');
    const working = (await b.orders(RA)).find((o) => o.id === placed.id);
    expect(working).toMatchObject({ state: 'pending', type: 'debit', price: 0.01, tag: 'strikecraft-sandbox-check' });
    expect(working!.legs.map((l) => l.side)).toEqual(['buy_to_open', 'sell_to_open']);
    expect(await b.cancelOrder(RA, placed.id)).toMatchObject({ id: placed.id, ok: true }); // "Cancel Requested"
    // /orders/live also lists today's terminal orders, so the cancel is observable there.
    expect((await b.orders(RA)).find((o) => o.id === placed.id)!.state).toBe('canceled');
  });

  it('the recorded quote token points at a DXLink host the adapter accepts', () => {
    const q = recording().find((x) => x.url.endsWith('/api-quote-tokens'))!;
    const u = new URL(JSON.parse(q.response).data['dxlink-url']);
    expect(u.protocol).toBe('wss:');
    expect(TASTYTRADE_HOSTS.dxlinkSuffixes.some((s) => u.hostname.endsWith(s))).toBe(true);
    const tok = recording().find((x) => x.url.endsWith('/oauth/token'))!;
    expect(JSON.parse(tok.response)).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
  });
});

describe('tastytrade in the broker registry', () => {
  const never: FetchLike = async () => {
    throw new Error('no request expected');
  };
  it('is available and builds an adapter that talks only to the cert host in the sandbox env', () => {
    expect(brokerEntry('tastytrade')).toMatchObject({ status: 'available' });
    expect(brokerEntry('tastytrade').plannedNote).toBeUndefined();
    const b = createBroker('tastytrade', { refreshToken: REFRESH, clientSecret: SECRET }, 'sandbox', { fetch: never });
    expect(b.id).toBe('tastytrade');
    expect(b.hosts).toEqual([TASTYTRADE_HOSTS.sandbox]);
    expect(b.hosts).toEqual(['api.cert.tastyworks.com']);
  });

  it('needs both credentials, and live orders stay off unless asked for', async () => {
    expect(() => createBroker('tastytrade', { refreshToken: REFRESH }, 'sandbox', { fetch: never })).toThrow(
      'clientSecret',
    );
    const live = createBroker('tastytrade', { refreshToken: REFRESH, clientSecret: SECRET }, 'live', { fetch: never });
    expect(live.hosts).toEqual([TASTYTRADE_HOSTS.live]);
    await expect(live.placeOrder('5WX01234', debit)).rejects.toBeInstanceOf(LiveTradingDisabledError);
  });
});
