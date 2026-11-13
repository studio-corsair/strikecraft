// A paper broker that lives in memory: no network, no account, no real money. It backs the
// hosted demo and the UI tests, and gives anyone a place to try an order before connecting a
// broker. Fills are simple and stated: a priced order fills at its limit the moment the limit is
// at or through the current mid; otherwise it stays working until canceled.
import { parseOcc } from '../symbols.ts';
import type { MarketDataSource } from '../types.ts';
import { validateOrder } from './types.ts';
import type {
  Balances,
  Broker,
  BrokerCapabilities,
  BrokerPosition,
  OrderLeg,
  OrderPreview,
  OrderRequest,
  OrderStatus,
} from './types.ts';

export const PAPER_CAPABILITIES: BrokerCapabilities = {
  optionOrders: true,
  multiLeg: true,
  realTimeOptionQuotes: 'uses whichever data source is active',
  realTimeQuality: 'partial',
  paperTrading: true,
  paperNote: 'built in, simulated fills',
  signIn: 'none',
  streaming: false,
};

export const PAPER_ACCOUNT = 'PAPER';

/** Per-share mid of a leg's instrument right now, or null when there is no usable quote. */
export type MidLookup = (underlying: string, legSymbol: string) => Promise<number | null>;

export interface PaperOptions {
  mid: MidLookup;
  cash?: number;
  positions?: BrokerPosition[];
  orders?: OrderStatus[];
  now?: () => number;
  /** Commission per option contract. Default 0. */
  commissionPerContract?: number;
}

const sign = (l: OrderLeg) => (l.side.startsWith('buy') ? 1 : -1);
const multiplier = (symbol: string) => (parseOcc(symbol) ? 100 : 1);

export function paperBroker(opts: PaperOptions): Broker {
  const now = opts.now ?? Date.now;
  let cash = opts.cash ?? 100_000;
  const positions = new Map<string, BrokerPosition>((opts.positions ?? []).map((p) => [p.symbol, { ...p }]));
  const orders: OrderStatus[] = (opts.orders ?? []).map((o) => ({ ...o }));
  let nextId = 1000 + orders.length;
  const perContract = opts.commissionPerContract ?? 0;

  /** Net per-share debit (positive) or credit (negative) of the package at current mids. */
  async function netMid(o: OrderRequest): Promise<number | null> {
    let net = 0;
    for (const l of o.legs) {
      const m = await opts.mid(o.underlying, l.symbol);
      if (m == null) return null;
      net += sign(l) * m * (l.quantity / gcdQty(o.legs)) * (multiplier(l.symbol) / packMult(o.legs));
    }
    return net;
  }
  const gcdQty = (legs: OrderLeg[]) => legs.reduce((g, l) => gcd(g, l.quantity), 0) || 1;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  /** Multiplier the package price is quoted in: 100 for option orders, 1 for stock-only. */
  const packMult = (legs: OrderLeg[]) => (legs.some((l) => parseOcc(l.symbol)) ? 100 : 1);

  /** Signed per-share price the order is willing to trade at: + pays, - receives; null = market. */
  const limitOf = (o: OrderRequest): number | null => {
    if (o.type === 'market') return null;
    if (o.type === 'even') return 0;
    if (o.type === 'credit') return -(o.price ?? 0);
    if (o.type === 'debit') return o.price ?? 0;
    // single-leg limit: paying when buying, receiving when selling
    return sign(o.legs[0]!) * (o.price ?? 0);
  };

  const commission = (o: OrderRequest) =>
    o.legs.reduce((s, l) => s + (parseOcc(l.symbol) ? l.quantity * perContract : 0), 0);

  function applyFill(o: OrderRequest, netPerShare: number) {
    const lots = gcdQty(o.legs);
    cash -= netPerShare * packMult(o.legs) * lots + commission(o);
    // Split the package price across legs in proportion to nothing fancier than the leg's own side:
    // cost basis per leg is tracked at the package level on the first leg and zero on the rest
    // would be misleading, so each leg records its quantity and the package cost is spread evenly.
    const perLeg = (netPerShare * packMult(o.legs) * lots) / o.legs.length;
    for (const l of o.legs) {
      const id = parseOcc(l.symbol);
      const prev = positions.get(l.symbol);
      const qty = (prev?.quantity ?? 0) + sign(l) * l.quantity;
      if (qty === 0) {
        positions.delete(l.symbol);
        continue;
      }
      positions.set(l.symbol, {
        symbol: l.symbol,
        underlying: id?.root ?? o.underlying.toUpperCase(),
        kind: id ? 'option' : 'stock',
        quantity: qty,
        costBasis: (prev?.costBasis ?? 0) + perLeg,
        expiry: id?.expiry,
        strike: id?.strike,
        right: id?.right,
        acquired: new Date(now()).toISOString(),
      });
    }
  }

  const md: MarketDataSource = { id: 'demo', label: 'Paper', delayMinutes: 0 };

  return {
    id: 'paper',
    label: 'Paper account',
    env: 'sandbox',
    liveOrdersAllowed: false,
    capabilities: PAPER_CAPABILITIES,
    hosts: [],
    async accounts() {
      return [{ id: PAPER_ACCOUNT, type: 'paper', optionLevel: 4, status: 'active' }];
    },
    async balances(accountId) {
      let market = 0;
      for (const p of positions.values()) {
        const m = await opts.mid(p.underlying, p.symbol);
        market += (m ?? 0) * p.quantity * multiplier(p.symbol);
      }
      const basis = [...positions.values()].reduce((s, p) => s + p.costBasis, 0);
      return {
        accountId,
        equity: cash + market,
        cash,
        optionBuyingPower: cash,
        stockBuyingPower: cash * 2,
        openPnl: market - basis,
      } satisfies Balances;
    },
    async positions() {
      return [...positions.values()].map((p) => ({ ...p }));
    },
    async orders() {
      return orders.map((o) => ({ ...o, legs: o.legs.map((l) => ({ ...l })) })).reverse();
    },
    async previewOrder(_accountId, order) {
      validateOrder(order);
      const mid = await netMid(order);
      const limit = limitOf(order);
      const perShare = limit ?? mid;
      const lots = gcdQty(order.legs);
      const cost = perShare == null ? null : perShare * packMult(order.legs) * lots;
      const warnings: string[] = [];
      if (mid == null) warnings.push('No usable quote for one of the legs: the mid price is unknown.');
      else if (limit != null && limit < mid - 1e-9)
        warnings.push(
          `Limit is below the current mid (${mid.toFixed(2)}): the order will rest until the market comes to it.`,
        );
      if (cost != null && cost + commission(order) > cash) warnings.push('Not enough cash in the paper account.');
      return {
        ok: cost == null || cost + commission(order) <= cash,
        cost: cost == null ? null : Math.round(cost * 100) / 100,
        commission: commission(order),
        fees: 0,
        marginChange: 0,
        warnings,
        raw: { paper: true, mid, limit },
      } satisfies OrderPreview;
    },
    async placeOrder(accountId, order) {
      const preview = await this.previewOrder(accountId, order);
      if (!preview.ok) throw new Error(`paper order rejected: ${preview.warnings.join(' ')}`);
      const mid = await netMid(order);
      const limit = limitOf(order);
      const marketable = mid != null && (limit == null || limit >= mid - 1e-9);
      const fillAt = limit ?? mid;
      const status: OrderStatus = {
        id: String(nextId++),
        state: marketable ? 'filled' : 'open',
        underlying: order.underlying.toUpperCase(),
        legs: order.legs.map((l) => ({ ...l })),
        type: order.type,
        price: order.price ?? null,
        duration: order.duration,
        createdAt: new Date(now()).toISOString(),
        filledQuantity: marketable ? gcdQty(order.legs) : 0,
        avgFillPrice: marketable && fillAt != null ? Math.abs(fillAt) : null,
        tag: order.tag ?? null,
      };
      if (marketable && fillAt != null) applyFill(order, fillAt);
      orders.push(status);
      return { id: status.id, state: status.state, raw: { paper: true } };
    },
    async cancelOrder(_accountId, orderId) {
      const o = orders.find((x) => x.id === orderId);
      if (!o) throw new Error(`no paper order ${orderId}`);
      if (o.state !== 'open' && o.state !== 'pending' && o.state !== 'partially_filled')
        throw new Error(`paper order ${orderId} is ${o.state} and cannot be canceled`);
      o.state = 'canceled';
      return { id: orderId, ok: true, raw: { paper: true } };
    },
    marketData: () => md,
    async stream() {
      return () => {};
    },
  };
}
