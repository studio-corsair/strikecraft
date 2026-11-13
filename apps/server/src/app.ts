// HTTP routes → service methods. Pure (no sockets), so the whole API is testable in-process.
import type { BrokerEnv, LegInput, OrderRequest, Service } from '@strikecraft/data';
import { BrokerError, LiveTradingDisabledError } from '@strikecraft/data';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
export interface ApiResponse {
  status: number;
  body: unknown;
}

class BadRequest extends Error {}

const obj = (b: unknown): Record<string, unknown> => {
  if (b == null || typeof b !== 'object' || Array.isArray(b))
    throw new BadRequest('the request body must be a JSON object');
  return b as Record<string, unknown>;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`"${name}" is required`);
  return v;
};
const env = (v: unknown): BrokerEnv => {
  if (v !== 'sandbox' && v !== 'live') throw new BadRequest('"env" must be "sandbox" or "live"');
  return v;
};
export function createApi(svc: Service) {
  async function route(req: ApiRequest): Promise<unknown> {
    const { method, path, query: q } = req;
    const key = `${method} ${path}`;
    switch (key) {
      case 'GET /api/status':
        return svc.status();
      case 'GET /api/quote':
        return svc.quote(str(q.get('symbol'), 'symbol'));
      case 'GET /api/expirations':
        return svc.expirations(str(q.get('symbol'), 'symbol'));
      case 'GET /api/chain':
        return svc.chain(str(q.get('symbol'), 'symbol'), str(q.get('expiry'), 'expiry'));
      case 'GET /api/vol':
        return svc.vol(str(q.get('symbol'), 'symbol'));
      case 'GET /api/account':
        return svc.account();
      case 'POST /api/analyze': {
        const b = obj(req.body);
        return svc.analyze(str(b.symbol, 'symbol'), (b.legs ?? []) as LegInput[], {
          ivShifts: b.ivShifts as number[] | undefined,
          dates: b.dates as string[] | undefined,
          moves: b.moves as number[] | undefined,
          steps: b.steps as number | undefined,
          model: b.model as 'bs' | 'american' | undefined,
        });
      }
      case 'POST /api/earnings': {
        const b = obj(req.body);
        return svc.earnings(str(b.symbol, 'symbol'), (b.legs ?? []) as LegInput[]);
      }
      case 'POST /api/orders/preview':
        return svc.previewOrder(obj(req.body) as unknown as OrderRequest);
      case 'POST /api/orders':
        return svc.placeOrder(obj(req.body) as unknown as OrderRequest);
      case 'POST /api/connections': {
        const b = obj(req.body);
        return svc.connect(str(b.broker, 'broker'), env(b.env), obj(b.credentials) as Record<string, string>);
      }
      case 'PUT /api/settings': {
        const b = obj(req.body);
        if (typeof b.allowLiveOrders !== 'boolean') throw new BadRequest('"allowLiveOrders" must be true or false');
        return svc.setSettings({ allowLiveOrders: b.allowLiveOrders });
      }
    }
    const order = /^\/api\/orders\/([^/]+)$/.exec(path);
    if (order && method === 'DELETE') return svc.cancelOrder(decodeURIComponent(order[1]!));
    const conn = /^\/api\/connections\/([a-z]+)$/.exec(path);
    if (conn && method === 'DELETE') return svc.disconnect(conn[1]!);
    return undefined;
  }

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      const out = await route(req);
      if (out === undefined) return { status: 404, body: { error: `no route ${req.method} ${req.path}` } };
      return { status: 200, body: out };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof LiveTradingDisabledError)
        return { status: 403, body: { error: message, code: 'live-trading-off' } };
      if (e instanceof BadRequest) return { status: 400, body: { error: message } };
      if (e instanceof BrokerError)
        return { status: 502, body: { error: message, code: 'broker', brokerStatus: e.status } };
      // Everything else is a request the service refused with a reason (unknown symbol, bad leg…).
      return { status: 422, body: { error: message } };
    }
  };
}
