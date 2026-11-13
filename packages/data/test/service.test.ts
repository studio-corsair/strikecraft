// The service is the whole API the UI uses. These tests run it over the simulated demo market
// (deterministic) and, for connections, against a stub Tradier.
import { describe, it, expect } from 'vitest';
import { createService, memoryStore } from '../src/service.ts';
import type { StateStore, SavedState } from '../src/service.ts';
import { demoSource, defaultDemoSnapshots } from '../src/demo.ts';
import { occ } from '../src/symbols.ts';
import { LiveTradingDisabledError } from '../src/broker/types.ts';
import type { FetchLike, OrderRequest } from '../src/broker/types.ts';

const demo = demoSource(defaultDemoSnapshots());
const never: FetchLike = async (url) => {
  throw new Error(`unexpected network request to ${url}`);
};

const demoService = () =>
  createService({
    mode: 'demo',
    baseSources: [demo],
    store: memoryStore(),
    deps: { fetch: never },
    engine: { now: () => demo.asOf },
    demo: { simulated: demo.simulated, symbols: demo.symbols, asOf: demo.asOf },
  });

describe('service over demo data', () => {
  it('reports status: demo mode, one delayed rung, the paper account, live orders off', async () => {
    const svc = await demoService();
    await svc.quote('NVDA');
    const st = await svc.status();
    expect(st.mode).toBe('demo');
    expect(st.demo).toMatchObject({ simulated: true, symbols: ['NVDA', 'SPY', 'AAPL', 'TSLA'] });
    expect(st.ladder.map((r) => [r.id, r.state])).toEqual([['demo', 'delayed']]);
    expect(st.activeBroker).toEqual({ id: 'paper', label: 'Paper account', env: 'sandbox', liveOrdersAllowed: false });
    expect(st.settings).toEqual({ allowLiveOrders: false });
    expect(st.brokers.map((b) => b.id)).toContain('tradier');
    expect(st.brokers.every((b) => !('create' in b))).toBe(true); // the catalog is data only
  });

  it('quotes with change and source, and rejects a malformed symbol', async () => {
    const svc = await demoService();
    const q = await svc.quote('nvda');
    expect(q).toMatchObject({ symbol: 'NVDA', price: 170.89, prevClose: 166.19, session: 'regular' });
    expect(q.changePct).toBeCloseTo(2.83, 2);
    expect(q.source).toMatchObject({ source: 'demo', sourceLabel: 'Simulated demo data' });
    await expect(svc.quote('NV DA; DROP')).rejects.toThrow('is not a valid symbol');
    await expect(svc.quote('MSFT')).rejects.toThrow('MSFT is not in the demo data');
  });

  it('lists expiries with days to expiry and flags the ones that span earnings', async () => {
    const svc = await demoService();
    const e = await svc.expirations('NVDA');
    expect(e.nextEarnings).toBe('2026-11-17');
    expect(e.expirations[0]).toEqual({ expiry: '2026-11-20', dte: 7, spansEarnings: true, firstAfterEarnings: true });
    expect(e.expirations.filter((x) => x.firstAfterEarnings).length).toBe(1);
    const spy = await svc.expirations('SPY');
    expect(spy.nextEarnings).toBeNull();
    expect(spy.expirations.every((x) => !x.spansEarnings)).toBe(true);
  });

  it('builds chain rows with call and put per strike, IV and greeks from the core', async () => {
    const svc = await demoService();
    const c = await svc.chain('NVDA', '2026-12-18');
    expect(c.rows.length).toBeGreaterThan(20);
    const row = c.rows.find((r) => r.strike === 185)!;
    expect(row.call).toMatchObject({ symbol: 'NVDA261218C00185000', markSource: 'mid' });
    expect(row.call!.iv).toBeGreaterThan(0.3);
    expect(row.call!.delta).toBeGreaterThan(0);
    expect(row.put!.delta).toBeLessThan(0);
    expect(row.call!.delta! - row.put!.delta!).toBeCloseTo(1, 1); // put-call parity on deltas
    expect(c.summary.expiry).toBe('2026-12-18');
    expect(c.sources.chain).toMatchObject({ source: 'demo' });
  });

  it('analyzes a position; the numbers are the core functions applied to the same inputs', async () => {
    const svc = await demoService();
    const out = await svc.analyze('NVDA', [{ qty: 1, type: 'C', strike: 185, expiry: '2026-12-18', entry: 4.71 }]);
    expect(out.position.cost).toBe(471);
    expect(out.position.legs[0]!.iv).toBeGreaterThan(0.3);
    expect(out.probability.breakevens.length).toBe(1);
    expect(out.probability.breakevens[0]).toBeCloseTo(189.71, 2);
    expect(out.probability.maxLoss).toBe(-471);
    expect(out.probability.maxProfit).toBe('unlimited');
    expect(out.riskProfile.rows.length).toBe(15); // 5 dates × 3 IV shifts
    expect(out.sources.chains.map((t) => t.source)).toEqual(['demo']);
    await expect(svc.analyze('NVDA', [])).rejects.toThrow('add at least one leg');
    await expect(svc.analyze('NVDA', [{ qty: 1, type: 'C' }])).rejects.toThrow('needs a strike and an expiry');
    await expect(svc.analyze('NVDA', [{ qty: 0, type: 'S' }])).rejects.toThrow('non-zero quantity');
  });

  it('prices earnings through the print for a position', async () => {
    const svc = await demoService();
    const e = await svc.earnings('NVDA', [{ qty: 1, type: 'C', strike: 185, expiry: '2026-12-18' }]);
    expect(e.nextEarnings.date).toBe('2026-11-17');
    expect(e.positionThroughEvent.grid.length).toBe(9);
    expect(e.positionThroughEvent.ivBeforeAfter[0].ivAfterCrush).toBeLessThan(
      e.positionThroughEvent.ivBeforeAfter[0].ivNow,
    );
  });
});

describe('paper orders through the service', () => {
  const C = occ('NVDA', '2026-12-18', 'C', 185);
  const buy = (price: number): OrderRequest => ({
    underlying: 'NVDA',
    type: 'limit',
    price,
    duration: 'day',
    legs: [{ symbol: C, side: 'buy_to_open', quantity: 2 }],
  });

  it('previews at the limit, rests an order below the mid, cancels it, and fills one at the mid', async () => {
    const svc = await demoService();
    const mid = (await svc.chain('NVDA', '2026-12-18')).rows.find((r) => r.strike === 185)!.call!.mark!;

    const low = await svc.previewOrder(buy(0.05));
    expect(low).toMatchObject({ ok: true, cost: 10, commission: 0, broker: { id: 'paper' } });
    expect(low.warnings[0]).toMatch(/below the current mid/);

    const resting = await svc.placeOrder(buy(0.05));
    expect(resting.state).toBe('open');
    let acct = await svc.account();
    expect(acct.orders[0]).toMatchObject({ id: resting.id, state: 'open', price: 0.05 });
    expect(acct.positions).toEqual([]);

    expect(await svc.cancelOrder(resting.id)).toMatchObject({ id: resting.id, ok: true });
    acct = await svc.account();
    expect(acct.orders[0]!.state).toBe('canceled');
    await expect(svc.cancelOrder(resting.id)).rejects.toThrow('is canceled and cannot be canceled');

    const price = Math.ceil(mid * 100) / 100 + 0.05;
    const filled = await svc.placeOrder(buy(price));
    expect(filled.state).toBe('filled');
    acct = await svc.account();
    expect(acct.positions).toHaveLength(1);
    expect(acct.positions[0]).toMatchObject({ symbol: C, kind: 'option', quantity: 2, underlying: 'NVDA' });
    expect(acct.positions[0]!.leg).toMatchObject({ qty: 2, type: 'C', strike: 185, expiry: '2026-12-18' });
    expect(acct.positions[0]!.leg.entry).toBeCloseTo(price, 6);
    expect(acct.balances.cash).toBeCloseTo(100_000 - price * 200, 6);
    expect(acct.accountMasked).toBe('Paper');
  });

  it('prices a vertical as a net debit and refuses an order the account cannot pay for', async () => {
    const svc = await demoService();
    const spread: OrderRequest = {
      underlying: 'NVDA',
      type: 'debit',
      price: 20,
      duration: 'day',
      legs: [
        { symbol: occ('NVDA', '2026-12-18', 'C', 170), side: 'buy_to_open', quantity: 1 },
        { symbol: occ('NVDA', '2026-12-18', 'C', 200), side: 'sell_to_open', quantity: 1 },
      ],
    };
    const p = await svc.previewOrder(spread);
    expect(p.cost).toBe(2000);
    const placed = await svc.placeOrder(spread); // 20.00 is far above the spread's mid: fills
    expect(placed.state).toBe('filled');
    expect((await svc.account()).positions.map((x) => x.quantity).sort()).toEqual([-1, 1]);
    const huge = { ...buy(900), legs: [{ symbol: C, side: 'buy_to_open' as const, quantity: 50 }] };
    await expect(svc.placeOrder(huge)).rejects.toThrow('Not enough cash in the paper account');
  });
});

describe('connections and the live-order switch', () => {
  it('the demo cannot connect a broker or switch live trading on', async () => {
    const svc = await demoService();
    await expect(svc.connect('tradier', 'sandbox', { token: 'x' })).rejects.toThrow('not available in the demo');
    await expect(svc.setSettings({ allowLiveOrders: true })).rejects.toThrow('not available in the demo');
  });

  function stubTradier() {
    const seen: { url: string; auth: string | undefined; body?: string; method: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, auth: init?.headers?.Authorization, body: init?.body, method: init?.method ?? 'GET' });
      const body = url.endsWith('/user/profile')
        ? { profile: { account: { account_number: 'VA12345678', type: 'margin', option_level: 3, status: 'active' } } }
        : init?.method === 'POST'
          ? { order: { id: 5, status: 'ok' } }
          : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    return { fetch, seen };
  }
  const order: OrderRequest = {
    underlying: 'NVDA',
    type: 'limit',
    price: 1,
    duration: 'day',
    legs: [{ symbol: occ('NVDA', '2026-12-18', 'C', 185), side: 'buy_to_open', quantity: 1 }],
  };

  it('verifies a key with a read-only call, stores it, masks the account and puts the broker on top of the ladder', async () => {
    const { fetch, seen } = stubTradier();
    let stored: SavedState | null = null;
    const store: StateStore = {
      load: async () => ({ connections: [], settings: { allowLiveOrders: false } }),
      save: async (s) => {
        stored = s;
      },
    };
    const svc = await createService({
      mode: 'local',
      baseSources: [demo],
      store,
      deps: { fetch },
      engine: { now: () => demo.asOf },
    });
    await expect(svc.connect('schwab', 'live', { appKey: 'a', appSecret: 'b' })).rejects.toThrow(
      'Charles Schwab is not available yet',
    );
    await expect(svc.connect('tradier', 'sandbox', { token: ' ' })).rejects.toThrow(
      'Tradier needs a value for "token"',
    );
    expect(await svc.connect('tradier', 'sandbox', { token: 'SECRET-TOKEN' })).toEqual({
      ok: true,
      broker: 'tradier',
      env: 'sandbox',
      accounts: 1,
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET https://sandbox.tradier.com/v1/user/profile']);
    expect(stored!.connections).toEqual([
      { broker: 'tradier', env: 'sandbox', credentials: { token: 'SECRET-TOKEN' }, accountId: 'VA12345678' },
    ]);
    const st = await svc.status();
    expect(st.connections).toEqual([
      {
        id: 'tradier',
        label: 'Tradier sandbox',
        env: 'sandbox',
        accountMasked: '••5678',
        hosts: ['sandbox.tradier.com'],
      },
    ]);
    expect(JSON.stringify(st)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(st)).not.toContain('VA12345678');
    expect(st.ladder.map((r) => r.id)).toEqual(['tradier', 'demo']);
    expect(st.activeBroker.id).toBe('tradier');
    await svc.disconnect('tradier');
    expect((await svc.status()).activeBroker.id).toBe('paper');
    expect(stored!.connections).toEqual([]);
  });

  it('never sends an order to a live account unless the setting is switched on', async () => {
    const { fetch, seen } = stubTradier();
    const svc = await createService({
      mode: 'local',
      baseSources: [demo],
      store: memoryStore(),
      deps: { fetch },
      engine: { now: () => demo.asOf },
    });
    await svc.connect('tradier', 'live', { token: 'LIVE-TOKEN' });
    seen.length = 0;
    await expect(svc.placeOrder(order)).rejects.toBeInstanceOf(LiveTradingDisabledError);
    await expect(svc.cancelOrder('5')).rejects.toBeInstanceOf(LiveTradingDisabledError);
    expect(seen).toEqual([]); // nothing left the machine
    expect((await svc.status()).activeBroker).toMatchObject({ env: 'live', liveOrdersAllowed: false });

    expect(await svc.setSettings({ allowLiveOrders: true })).toEqual({ allowLiveOrders: true });
    expect((await svc.status()).activeBroker.liveOrdersAllowed).toBe(true);
    expect((await svc.placeOrder(order)).id).toBe('5');
    expect(seen.map((s) => new URL(s.url).host)).toEqual(['api.tradier.com']);
    expect(seen[0]!.body).not.toContain('preview');

    await svc.setSettings({ allowLiveOrders: false });
    seen.length = 0;
    await expect(svc.placeOrder(order)).rejects.toBeInstanceOf(LiveTradingDisabledError);
    expect(seen).toEqual([]);
  });
});
