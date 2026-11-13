// The UI's only door to data. Two implementations of the same interface:
//   - httpApi: talks to the local Strikecraft server on the same origin (/api/*).
//   - demoApi: runs the very same service in the browser over simulated data, so the hosted
//     demo needs no server and nothing leaves the page.
import type { BrokerEnv, LegInput, OrderRequest, Service, Settings } from '@strikecraft/data';

declare const __DEMO__: boolean;

export type Api = Pick<
  Service,
  | 'status'
  | 'quote'
  | 'expirations'
  | 'chain'
  | 'analyze'
  | 'earnings'
  | 'account'
  | 'previewOrder'
  | 'placeOrder'
  | 'cancelOrder'
  | 'connect'
  | 'disconnect'
  | 'setSettings'
>;

export type Status = Awaited<ReturnType<Api['status']>>;
export type Quote = Awaited<ReturnType<Api['quote']>>;
export type Expirations = Awaited<ReturnType<Api['expirations']>>;
export type Chain = Awaited<ReturnType<Api['chain']>>;
export type ChainRow = Chain['rows'][number];
export type ChainCell = NonNullable<ChainRow['call']>;
export type Analysis = Awaited<ReturnType<Api['analyze']>>;
export type Earnings = Awaited<ReturnType<Api['earnings']>>;
export type Account = Awaited<ReturnType<Api['account']>>;
export type Preview = Awaited<ReturnType<Api['previewOrder']>>;
export type { LegInput, OrderRequest, BrokerEnv, Settings };

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Strikecraft': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(`Cannot reach the Strikecraft server (${(e as Error).message}). Is it still running?`, 0);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new ApiError(
      `The server sent something that is not JSON (HTTP ${res.status}, ${(e as Error).message})`,
      res.status,
    );
  }
  if (!res.ok) {
    const j = json as { error?: string; code?: string } | null;
    throw new ApiError(j?.error ?? `HTTP ${res.status}`, res.status, j?.code ?? null);
  }
  return json as T;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const httpApi: Api = {
  status: () => call('GET', '/api/status'),
  quote: (symbol) => call('GET', `/api/quote?${q({ symbol })}`),
  expirations: (symbol) => call('GET', `/api/expirations?${q({ symbol })}`),
  chain: (symbol, expiry) => call('GET', `/api/chain?${q({ symbol, expiry })}`),
  analyze: (symbol, legs, opts) => call('POST', '/api/analyze', { symbol, legs, ...opts }),
  earnings: (symbol, legs) => call('POST', '/api/earnings', { symbol, legs }),
  account: () => call('GET', '/api/account'),
  previewOrder: (order) => call('POST', '/api/orders/preview', order),
  placeOrder: (order) => call('POST', '/api/orders', order),
  cancelOrder: (id) => call('DELETE', `/api/orders/${encodeURIComponent(id)}`),
  connect: (broker, env, credentials) => call('POST', '/api/connections', { broker, env, credentials }),
  disconnect: (broker) => call('DELETE', `/api/connections/${encodeURIComponent(broker)}`),
  setSettings: (patch) => call('PUT', '/api/settings', patch),
};

/** The service itself, in the browser, on simulated data. Loaded only for the hosted demo build. */
async function demoApi(): Promise<Api> {
  const { createService, memoryStore, demoSource, defaultDemoSnapshots } = await import('@strikecraft/data');
  const demo = demoSource(defaultDemoSnapshots());
  const svc = await createService({
    mode: 'demo',
    baseSources: [demo],
    store: memoryStore(),
    deps: {
      fetch: async (url) => {
        throw new Error(`the demo makes no network requests (blocked: ${new URL(url).host})`);
      },
    },
    engine: { now: () => demo.asOf },
    demo: { simulated: demo.simulated, symbols: demo.symbols, asOf: demo.asOf },
    version: 'demo',
  });
  // Results cross a JSON boundary exactly as they do over HTTP, so both modes behave the same.
  const json =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> =>
      JSON.parse(JSON.stringify(await fn(...a))) as R;
  return {
    status: json(svc.status),
    quote: json(svc.quote),
    expirations: json(svc.expirations),
    chain: json(svc.chain),
    analyze: json(svc.analyze),
    earnings: json(svc.earnings),
    account: json(svc.account),
    previewOrder: json(svc.previewOrder),
    placeOrder: json(svc.placeOrder),
    cancelOrder: json(svc.cancelOrder),
    connect: json(svc.connect),
    disconnect: json(svc.disconnect),
    setSettings: json(svc.setSettings),
  };
}

let cached: Promise<Api> | null = null;
export const getApi = (): Promise<Api> => (cached ??= __DEMO__ ? demoApi() : Promise.resolve(httpApi));
