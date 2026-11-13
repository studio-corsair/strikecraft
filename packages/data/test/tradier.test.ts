// Contract tests for the Tradier adapter, replaying exchanges recorded from the real sandbox on
// 2026-11-13 by scripts/tradier-sandbox.ts (account number, name and token scrubbed).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { tradierBroker, tradierOrderParams, rangeStart, TRADIER_HOSTS } from '../src/broker/tradier.ts';
import type { SocketLike } from '../src/broker/tradier.ts';
import { BrokerError, LiveTradingDisabledError, validateOrder } from '../src/broker/types.ts';
import type { FetchLike, OrderRequest, StreamQuote } from '../src/broker/types.ts';
import { parseOcc } from '../src/symbols.ts';

type Rec = { method: string; url: string; body: string | null; status: number; response: string };
const RECORDED: Rec[] = JSON.parse(
  fs.readFileSync(new URL('./fixtures/tradier-sandbox.json', import.meta.url), 'utf8'),
);
const ACCT = 'VA00000000';
const TOKEN = 'test-token-not-real';

/** Replays recorded exchanges in order per (method, url, body); records every request made. */
function replay(extra: Rec[] = []) {
  const queue = [...extra, ...RECORDED];
  const requests: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url, headers: init?.headers ?? {}, body: init?.body });
    const i = queue.findIndex((r) => r.method === method && r.url === url && (r.body ?? undefined) === init?.body);
    if (i < 0) throw new Error(`no recorded exchange for ${method} ${url} ${init?.body ?? ''}`);
    const [r] = queue.splice(i, 1);
    return { ok: r!.status >= 200 && r!.status < 300, status: r!.status, text: async () => r!.response };
  };
  return { fetch, requests };
}

/** The 2-leg order the recording placed, rebuilt from the recorded request body. */
function recordedOrder(): OrderRequest {
  const body = new URLSearchParams(
    RECORDED.find((r) => r.method === 'POST' && r.body?.includes('preview=true'))!.body!,
  );
  return {
    underlying: body.get('symbol')!,
    type: body.get('type') as OrderRequest['type'],
    price: Number(body.get('price')),
    duration: body.get('duration') as OrderRequest['duration'],
    tag: body.get('tag') ?? undefined,
    legs: [0, 1].map((i) => ({
      symbol: body.get(`option_symbol[${i}]`)!,
      side: body.get(`side[${i}]`) as OrderRequest['legs'][number]['side'],
      quantity: Number(body.get(`quantity[${i}]`)),
    })),
  };
}

describe('Tradier adapter on recorded sandbox exchanges', () => {
  it('reads accounts, balances and positions', async () => {
    const { fetch } = replay();
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch });
    expect(await b.accounts()).toEqual([{ id: ACCT, type: 'margin', optionLevel: 6, status: 'active' }]);
    const bal = await b.balances(ACCT);
    expect(bal.accountId).toBe(ACCT);
    expect(bal.equity).toBeGreaterThan(0);
    expect(bal.optionBuyingPower).toBeGreaterThan(0);
    const pos = await b.positions(ACCT);
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.every((p) => p.kind === 'stock' && p.underlying === p.symbol && p.quantity > 0)).toBe(true);
  });

  it('serves quotes and chains as a market-data rung tagged tradier, delayed in the sandbox', async () => {
    const { fetch } = replay();
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch, now: () => 1_794_570_000_000 });
    const md = b.marketData();
    expect(md).toMatchObject({ id: 'tradier', label: 'Tradier sandbox', delayMinutes: 15 });
    const q = await md.quote!('NVDA');
    expect(q).toMatchObject({ symbol: 'NVDA', source: 'tradier', delayed: true, delayMinutes: 15, currency: 'USD' });
    expect(q.lastPrice).toBeGreaterThan(0);
    expect(q.bid).toBeGreaterThan(0);
    expect(['regular', 'pre', 'post', 'closed']).toContain(q.session);
    const e = await md.expirations!('NVDA');
    expect(e.expirations).toContain('2026-12-18');
    expect([...e.expirations].sort()).toEqual(e.expirations);
    const chainUrl = RECORDED.find((r) => r.url.includes('/markets/options/chains'))!.url;
    const expiry = new URL(chainUrl).searchParams.get('expiration')!;
    const c = await md.optionChain!('NVDA', expiry);
    expect(c).toMatchObject({ symbol: 'NVDA', expiry, source: 'tradier', delayed: true });
    expect(c.calls.length).toBeGreaterThan(5);
    expect(c.calls.length).toBe(c.puts.length);
    const row = c.calls[0]!;
    expect(parseOcc(row.contractSymbol)).toMatchObject({ root: 'NVDA', expiry, right: 'C', strike: row.strike });
    expect(c.calls.map((r) => r.strike)).toEqual([...c.calls.map((r) => r.strike)].sort((x, y) => x - y));
  });

  it('previews, places, lists and cancels the recorded 2-leg order', async () => {
    const { fetch, requests } = replay();
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch });
    const order = recordedOrder();
    expect(order.legs.map((l) => l.side)).toEqual(['buy_to_open', 'sell_to_open']);

    const preview = await b.previewOrder(ACCT, order);
    expect(preview.ok).toBe(true);
    expect(preview.commission).toBeGreaterThan(0);
    expect(preview.cost).toBeGreaterThan(0);
    expect(requests.at(-1)!.body).toContain('preview=true');

    const placed = await b.placeOrder(ACCT, order);
    expect(placed.id).toMatch(/^\d+$/);
    expect(requests.at(-1)!.body).not.toContain('preview');
    expect(requests.at(-1)!.body).toContain('class=multileg');

    const listed = (await b.orders(ACCT)).find((o) => o.id === placed.id)!;
    expect(listed).toMatchObject({ underlying: 'NVDA', type: 'debit', price: 0.01, duration: 'day' });
    expect(['pending', 'open']).toContain(listed.state);
    expect(listed.legs).toEqual(order.legs);

    const cancel = await b.cancelOrder(ACCT, placed.id);
    expect(cancel).toMatchObject({ id: placed.id, ok: true });
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE' });
    const after = (await b.orders(ACCT)).find((o) => o.id === placed.id)!;
    expect(after.state).toBe('canceled');
  });

  it('sends the token only to the Tradier sandbox host, as a bearer header', async () => {
    const { fetch, requests } = replay();
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch });
    await b.accounts();
    await b.balances(ACCT);
    await b.marketData().quote!('NVDA');
    expect(b.hosts).toEqual([TRADIER_HOSTS.sandbox]);
    expect(requests.length).toBeGreaterThan(3);
    for (const r of requests) {
      expect(new URL(r.url).host).toBe('sandbox.tradier.com');
      expect(new URL(r.url).protocol).toBe('https:');
      expect(r.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
      expect(r.body ?? '').not.toContain(TOKEN);
    }
  });
});

describe('Tradier live-trading guard', () => {
  const order = recordedOrder();
  const never: FetchLike = async (url) => {
    throw new Error(`unexpected request to ${url}`);
  };

  it('refuses to place or cancel on a live account before any request is made', async () => {
    let calls = 0;
    const counting: FetchLike = async (u) => {
      calls++;
      return never(u);
    };
    const live = tradierBroker({ token: TOKEN, env: 'live', fetch: counting });
    expect(live.liveOrdersAllowed).toBe(false);
    await expect(live.placeOrder(ACCT, order)).rejects.toBeInstanceOf(LiveTradingDisabledError);
    await expect(live.placeOrder(ACCT, order)).rejects.toThrow(/live trading is off/);
    await expect(live.cancelOrder(ACCT, '1')).rejects.toBeInstanceOf(LiveTradingDisabledError);
    expect(calls).toBe(0);
  });

  it('a live preview is allowed and goes to the live host with preview=true', async () => {
    const seen: { url: string; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, body: init?.body });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ order: { status: 'ok', cost: 1.7, commission: 0.7 } }),
      };
    };
    const live = tradierBroker({ token: TOKEN, env: 'live', fetch });
    expect((await live.previewOrder(ACCT, order)).ok).toBe(true);
    expect(new URL(seen[0]!.url).host).toBe('api.tradier.com');
    expect(seen[0]!.body).toContain('preview=true');
    expect(live.marketData()).toMatchObject({ label: 'Tradier', delayMinutes: 0 });
  });

  it('places on live only when the explicit setting is on', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push(`${init?.method} ${url} ${init?.body}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ order: { id: 77, status: 'ok' } }) };
    };
    const live = tradierBroker({ token: TOKEN, env: 'live', fetch, allowLiveOrders: true });
    expect(live.liveOrdersAllowed).toBe(true);
    expect((await live.placeOrder(ACCT, order)).id).toBe('77');
    expect(seen[0]).not.toContain('preview');
    // The sandbox never counts as live, whatever the flag says.
    expect(tradierBroker({ token: TOKEN, env: 'sandbox', fetch, allowLiveOrders: true }).liveOrdersAllowed).toBe(false);
  });
});

describe('Tradier order form', () => {
  const C = 'NVDA261218C00185000';
  const C2 = 'NVDA261218C00200000';
  it('maps one option leg, a stock order, a multileg and a stock+option combo', () => {
    expect(
      tradierOrderParams({
        underlying: 'nvda',
        type: 'limit',
        price: 4.7,
        duration: 'gtc',
        legs: [{ symbol: C, side: 'buy_to_open', quantity: 2 }],
      }),
    ).toEqual({
      class: 'option',
      symbol: 'NVDA',
      duration: 'gtc',
      type: 'limit',
      price: '4.7',
      option_symbol: C,
      side: 'buy_to_open',
      quantity: '2',
    });
    expect(
      tradierOrderParams({
        underlying: 'NVDA',
        type: 'market',
        duration: 'day',
        legs: [{ symbol: 'NVDA', side: 'buy', quantity: 10 }],
      }),
    ).toEqual({ class: 'equity', symbol: 'NVDA', duration: 'day', type: 'market', side: 'buy', quantity: '10' });
    expect(
      tradierOrderParams({
        underlying: 'NVDA',
        type: 'credit',
        price: 1.1,
        duration: 'day',
        legs: [
          { symbol: C, side: 'sell_to_open', quantity: 1 },
          { symbol: C2, side: 'buy_to_open', quantity: 1 },
        ],
      }),
    ).toEqual({
      class: 'multileg',
      symbol: 'NVDA',
      duration: 'day',
      type: 'credit',
      price: '1.1',
      'option_symbol[0]': C,
      'side[0]': 'sell_to_open',
      'quantity[0]': '1',
      'option_symbol[1]': C2,
      'side[1]': 'buy_to_open',
      'quantity[1]': '1',
    });
    const combo = tradierOrderParams({
      underlying: 'NVDA',
      type: 'debit',
      price: 165,
      duration: 'day',
      legs: [
        { symbol: 'NVDA', side: 'buy', quantity: 100 },
        { symbol: C, side: 'sell_to_open', quantity: 1 },
      ],
    });
    expect(combo.class).toBe('combo');
    expect(combo['option_symbol[0]']).toBeUndefined();
    expect(combo['option_symbol[1]']).toBe(C);
  });

  it('rejects malformed orders with the reason', () => {
    const leg = { symbol: C, side: 'buy_to_open' as const, quantity: 1 };
    expect(() => validateOrder({ underlying: 'X', type: 'limit', price: 1, duration: 'day', legs: [] })).toThrow(
      'at least one leg',
    );
    expect(() => validateOrder({ underlying: 'X', type: 'limit', duration: 'day', legs: [leg] })).toThrow(
      'needs a price above zero',
    );
    expect(() =>
      validateOrder({ underlying: 'X', type: 'limit', price: 1, duration: 'day', legs: [{ ...leg, quantity: 1.5 }] }),
    ).toThrow('positive whole number');
    expect(() =>
      validateOrder({ underlying: 'X', type: 'limit', price: 1, duration: 'day', legs: [leg, leg] }),
    ).toThrow('debit, credit or even');
    expect(() => validateOrder({ underlying: 'X', type: 'debit', price: 1, duration: 'day', legs: [leg] })).toThrow(
      'limit or market',
    );
    expect(() =>
      validateOrder({ underlying: 'X', type: 'even', duration: 'day', legs: [leg, leg, leg, leg, leg] }),
    ).toThrow('at most 4 legs');
    expect(() =>
      tradierOrderParams({
        underlying: 'X',
        type: 'market',
        duration: 'day',
        legs: [{ symbol: 'X', side: 'buy_to_open', quantity: 1 }],
      }),
    ).toThrow('a stock leg is bought or sold');
  });

  it('turns a range into a start date', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(rangeStart('1y', now)).toBe('2025-11-13');
    expect(rangeStart('6mo', now)).toBe('2026-05-13');
    expect(rangeStart('5d', now)).toBe('2026-11-08');
    expect(() => rangeStart('forever', now)).toThrow('bad range');
  });
});

describe('Tradier errors and streaming', () => {
  it('reports API errors with the broker message and status', async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ errors: { error: ['Backoffice rejected override of the order.', 'InitialMargin'] } }),
    });
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch });
    const err = await b.previewOrder(ACCT, recordedOrder()).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      `Tradier POST /accounts/${ACCT}/orders failed (HTTP 400): Backoffice rejected override of the order.; InitialMargin`,
    );
    const plain: FetchLike = async () => ({ ok: false, status: 401, text: async () => 'Invalid Access Token' });
    await expect(tradierBroker({ token: 'bad', env: 'sandbox', fetch: plain }).accounts()).rejects.toThrow(
      'Tradier GET /user/profile failed (HTTP 401): Invalid Access Token',
    );
  });

  it('treats empty collections ("null") as empty lists', async () => {
    const fetch: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.includes('/orders') ? { orders: 'null' } : { positions: 'null' }),
    });
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch });
    expect(await b.orders(ACCT)).toEqual([]);
    expect(await b.positions(ACCT)).toEqual([]);
  });

  it('polls quotes in the sandbox and stops when asked', async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ quotes: { quote: { symbol: 'NVDA', bid: 170.4, ask: 170.45, last: 166.19 } } }),
      };
    };
    const got: StreamQuote[] = [];
    const b = tradierBroker({ token: TOKEN, env: 'sandbox', fetch, pollMs: 5, now: () => 42 });
    const stop = await b.stream(['NVDA'], (q) => got.push(q));
    expect(got[0]).toEqual({ symbol: 'NVDA', bid: 170.4, ask: 170.45, last: 166.19, at: 42 });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    const seen = n;
    expect(seen).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(seen);
  });

  it('streams live quotes over the websocket, merging quote and trade events', async () => {
    const sockets: (SocketLike & { url: string; sent: string[]; closed: boolean })[] = [];
    class FakeSocket implements SocketLike {
      url: string;
      sent: string[] = [];
      closed = false;
      onopen: SocketLike['onopen'] = null;
      onmessage: SocketLike['onmessage'] = null;
      onerror: SocketLike['onerror'] = null;
      onclose: SocketLike['onclose'] = null;
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }
      send(d: string) {
        this.sent.push(d);
      }
      close() {
        this.closed = true;
      }
    }
    const fetch: FetchLike = async (url, init) => {
      expect(`${init?.method} ${url}`).toBe('POST https://api.tradier.com/v1/markets/events/session');
      return { ok: true, status: 200, text: async () => JSON.stringify({ stream: { sessionid: 'sess-1' } }) };
    };
    const got: StreamQuote[] = [];
    const errors: string[] = [];
    const b = tradierBroker({ token: TOKEN, env: 'live', fetch, WebSocket: FakeSocket });
    const stop = await b.stream(
      ['NVDA'],
      (q) => got.push(q),
      (e) => errors.push(e.message),
    );
    const ws = sockets[0]!;
    expect(ws.url).toBe('wss://ws.tradier.com/v1/markets/events');
    ws.onopen!({});
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      symbols: ['NVDA'],
      sessionid: 'sess-1',
      filter: ['quote', 'trade'],
      linebreak: true,
    });
    ws.onmessage!({
      data:
        '{"type":"quote","symbol":"NVDA","bid":170.4,"ask":170.45,"biddate":"1794569824000"}\n' +
        '{"type":"trade","symbol":"NVDA","price":"170.42","date":"1794569825000"}\n' +
        '{"type":"summary","symbol":"NVDA"}\nnot json',
    });
    expect(got).toEqual([
      { symbol: 'NVDA', bid: 170.4, ask: 170.45, last: null, at: 1794569824000 },
      { symbol: 'NVDA', bid: 170.4, ask: 170.45, last: 170.42, at: 1794569825000 },
    ]);
    expect(errors).toEqual([expect.stringContaining('not JSON: not json')]);
    stop();
    expect(ws.closed).toBe(true);
  });
});
