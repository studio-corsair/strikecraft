// One interface for every broker. The app never talks to a broker except through this, and a
// broker adapter never talks to any host except its own broker's (there is a test for that).
//
// Safety model for orders:
//   - previewOrder never places anything.
//   - placeOrder / cancelOrder against a LIVE account throw LiveTradingDisabledError before any
//     request is made, unless the adapter was built with allowLiveOrders: true. The app only sets
//     that from an explicit user setting that is off by default.
import type { MarketDataSource } from '../types.ts';

export type BrokerId =
  | 'tradier'
  | 'tastytrade'
  | 'schwab'
  | 'alpaca'
  | 'tradestation'
  | 'etrade'
  | 'ibkr'
  /** The built-in in-memory paper account. */
  | 'paper';
export type BrokerEnv = 'sandbox' | 'live';

export interface BrokerCapabilities {
  optionOrders: boolean;
  multiLeg: boolean;
  /** Free-text note shown in Connections, e.g. "with funded account". */
  realTimeOptionQuotes: string;
  realTimeQuality: 'yes' | 'partial' | 'no';
  paperTrading: boolean;
  paperNote?: string;
  signIn: string;
  streaming: boolean;
}

export interface BrokerAccount {
  id: string;
  type: string;
  optionLevel: number | null;
  status: string;
}

export interface Balances {
  accountId: string;
  equity: number;
  cash: number;
  optionBuyingPower: number | null;
  stockBuyingPower: number | null;
  openPnl: number | null;
}

export interface BrokerPosition {
  /** Ticker for stock, OCC symbol for an option. */
  symbol: string;
  underlying: string;
  kind: 'stock' | 'option';
  /** Signed: shares for stock, contracts for options. */
  quantity: number;
  /** Total cost basis in dollars (positive for a long position). */
  costBasis: number;
  expiry?: string;
  strike?: number;
  right?: 'C' | 'P';
  acquired?: string | null;
}

export type OrderSide = 'buy' | 'sell' | 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';

export interface OrderLeg {
  /** OCC symbol for an option leg, ticker for a stock leg. */
  symbol: string;
  side: OrderSide;
  quantity: number;
}

export interface OrderRequest {
  underlying: string;
  legs: OrderLeg[];
  /**
   * market, or a priced order. For one leg use 'limit'; for several legs use 'debit' (you pay
   * `price` net), 'credit' (you receive `price` net) or 'even'.
   */
  type: 'market' | 'limit' | 'debit' | 'credit' | 'even';
  /** Per-share limit or net price; required unless type is market or even. */
  price?: number;
  duration: 'day' | 'gtc';
  /** Client tag stored with the order where the broker supports it. */
  tag?: string;
}

export interface OrderPreview {
  ok: boolean;
  /** Net cash effect in dollars: positive = you pay, negative = you receive. */
  cost: number | null;
  commission: number | null;
  fees: number | null;
  marginChange: number | null;
  /** Broker messages worth showing before the user confirms. */
  warnings: string[];
  /** The broker's own response, for the details view. */
  raw: unknown;
}

export type OrderState = 'pending' | 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired';

export interface OrderStatus {
  id: string;
  state: OrderState;
  underlying: string;
  legs: OrderLeg[];
  type: string;
  price: number | null;
  duration: string;
  createdAt: string | null;
  filledQuantity: number;
  avgFillPrice: number | null;
  tag?: string | null;
}

export interface PlacedOrder {
  id: string;
  state: OrderState;
  raw: unknown;
}

export interface StreamQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** Epoch ms. */
  at: number;
}

export interface Broker {
  id: BrokerId;
  label: string;
  env: BrokerEnv;
  /** True only when the user explicitly switched live trading on. */
  liveOrdersAllowed: boolean;
  capabilities: BrokerCapabilities;
  /** The only hosts this adapter sends requests (and the key) to. */
  hosts: string[];
  accounts(): Promise<BrokerAccount[]>;
  balances(accountId: string): Promise<Balances>;
  positions(accountId: string): Promise<BrokerPosition[]>;
  orders(accountId: string): Promise<OrderStatus[]>;
  previewOrder(accountId: string, order: OrderRequest): Promise<OrderPreview>;
  placeOrder(accountId: string, order: OrderRequest): Promise<PlacedOrder>;
  cancelOrder(accountId: string, orderId: string): Promise<{ id: string; ok: boolean; raw: unknown }>;
  /** This broker as a rung of the market-data ladder. */
  marketData(): MarketDataSource;
  /** Streaming quotes; returns a function that stops the stream. */
  stream(symbols: string[], onQuote: (q: StreamQuote) => void, onError?: (e: Error) => void): Promise<() => void>;
}

export class LiveTradingDisabledError extends Error {
  constructor(broker: string, action: string) {
    super(
      `${action} blocked: ${broker} is connected to a LIVE account and live trading is off. ` +
        'Turn on "Allow live orders" in Settings to send real orders, or connect the sandbox.',
    );
    this.name = 'LiveTradingDisabledError';
  }
}

export class BrokerError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
    this.body = body;
  }
}

/** Minimal fetch shape an adapter needs; injected so adapters run in tests, Node and the browser. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function validateOrder(o: OrderRequest): void {
  if (!o.legs.length) throw new Error('an order needs at least one leg');
  if (o.legs.length > 4) throw new Error('an order can have at most 4 legs');
  for (const l of o.legs) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0)
      throw new Error(`leg ${l.symbol}: quantity must be a positive whole number`);
  }
  const priced = o.type === 'limit' || o.type === 'debit' || o.type === 'credit';
  if (priced && !(typeof o.price === 'number' && o.price > 0))
    throw new Error(`a ${o.type} order needs a price above zero`);
  if (o.legs.length > 1 && o.type === 'limit')
    throw new Error('a multi-leg order is priced as debit, credit or even, not limit');
  if (o.legs.length === 1 && (o.type === 'debit' || o.type === 'credit' || o.type === 'even'))
    throw new Error('a single-leg order is priced as limit or market');
}
