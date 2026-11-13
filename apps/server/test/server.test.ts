// The local server over a real socket: API routes, the same-origin guards, static files, the key
// file's permissions, and the rule that a broker key only ever travels to its broker.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { createService, demoSource, defaultDemoSnapshots, memoryStore } from '@strikecraft/data';
import type { FetchLike, StateStore } from '@strikecraft/data';
import { createServer, listen, hostAllowed } from '../src/server.ts';
import { fileStore } from '../src/store.ts';
import { parseArgs, serviceOptions, HELP, makeNodeFetch } from '../src/main.ts';

const demo = demoSource(defaultDemoSnapshots());
const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  dirs.push(d);
  return d;
};

async function start(
  o: { fetch?: FetchLike; store?: StateStore; mode?: 'local' | 'demo'; staticDir?: string; allowHosts?: string[] } = {},
) {
  const service = await createService({
    mode: o.mode ?? 'demo',
    baseSources: [demo],
    store: o.store ?? memoryStore(),
    deps: {
      fetch:
        o.fetch ??
        (async (url) => {
          throw new Error(`unexpected outbound request to ${url}`);
        }),
    },
    engine: { now: () => demo.asOf },
    demo: { simulated: true, symbols: demo.symbols, asOf: demo.asOf },
    version: 'test',
  });
  const server = createServer({ service, port: 0, staticDir: o.staticDir, allowHosts: o.allowHosts });
  servers.push(server);
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'X-Strikecraft': '1', 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { base, port, call };
}

const LEG = { qty: 1, type: 'C', strike: 185, expiry: '2026-12-18', entry: 4.71 };

describe('API over HTTP', () => {
  it('serves status, quotes, chains and analysis', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/status')).json).toMatchObject({ mode: 'demo', version: 'test' });
    expect((await call('GET', '/api/quote?symbol=NVDA')).json).toMatchObject({ symbol: 'NVDA', price: 170.89 });
    const chain = await call('GET', '/api/chain?symbol=NVDA&expiry=2026-12-18');
    expect(chain.json.rows.length).toBeGreaterThan(20);
    const an = await call('POST', '/api/analyze', { symbol: 'NVDA', legs: [LEG] });
    expect(an.status).toBe(200);
    expect(an.json.position.cost).toBe(471);
    expect(an.json.sources.chain.source).toBe('demo');
    expect(an.headers.get('cache-control')).toBe('no-store');
  });

  it('answers bad requests with a reason and the right status', async () => {
    const { call } = await start();
    expect(await call('GET', '/api/quote')).toMatchObject({ status: 400, json: { error: '"symbol" is required' } });
    expect((await call('GET', '/api/quote?symbol=MSFT')).status).toBe(422);
    expect((await call('GET', '/api/nope')).json).toEqual({ error: 'no route GET /api/nope' });
    expect((await call('POST', '/api/analyze', [1, 2])).json).toEqual({
      error: 'the request body must be a JSON object',
    });
    expect(await call('PUT', '/api/settings', { allowLiveOrders: 'yes' })).toMatchObject({ status: 400 });
    expect(
      (await call('POST', '/api/connections', { broker: 'tradier', env: 'prod', credentials: {} })).json.error,
    ).toBe('"env" must be "sandbox" or "live"');
  });

  it('places and cancels a paper order', async () => {
    const { call } = await start();
    const order = {
      underlying: 'NVDA',
      type: 'limit',
      price: 0.05,
      duration: 'day',
      legs: [{ symbol: 'NVDA261218C00185000', side: 'buy_to_open', quantity: 1 }],
    };
    expect((await call('POST', '/api/orders/preview', order)).json).toMatchObject({ ok: true, cost: 5 });
    const placed = await call('POST', '/api/orders', order);
    expect(placed.json.state).toBe('open');
    expect((await call('DELETE', `/api/orders/${placed.json.id}`)).json).toMatchObject({ ok: true });
    expect((await call('GET', '/api/account')).json.orders[0].state).toBe('canceled');
  });
});

describe('same-origin guards', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const { port } = await start();
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      // fetch() cannot set Host, so speak HTTP directly.
      import('node:http').then(({ default: h }) => {
        const req = h.request(
          { host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'evil.example' } },
          (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      }, reject);
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'this host name is not allowed' });
    expect(hostAllowed('localhost:4173', new Set(['localhost']))).toBe(true);
    expect(hostAllowed('evil.example', new Set(['localhost']))).toBe(false);
    expect(hostAllowed(undefined, new Set(['localhost']))).toBe(false);
  });

  it('rejects a cross-origin request and a write without the app header or JSON type', async () => {
    const { call, base } = await start();
    expect((await call('GET', '/api/status', undefined, { Origin: 'https://evil.example' })).json).toEqual({
      error: 'cross-origin requests are not allowed',
    });
    expect((await call('GET', '/api/status', undefined, { Origin: base })).status).toBe(200);
    // What a cross-site form post looks like: no custom header, a form content type.
    const form = await fetch(`${base}/api/orders`, {
      method: 'POST',
      body: 'a=1',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(form.status).toBe(403);
    expect(
      (await call('POST', '/api/analyze', { symbol: 'NVDA', legs: [LEG] }, { 'Content-Type': 'text/plain' })).status,
    ).toBe(415);
    const big = await call('POST', '/api/analyze', { symbol: 'NVDA', pad: 'x'.repeat(300_000) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      body: '{not json',
      headers: { 'Content-Type': 'application/json', 'X-Strikecraft': '1' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('reaching it under another name (a tailnet HTTPS address)', () => {
  // Speak HTTP directly: fetch() cannot set the Host header.
  const raw = async (port: number, headers: Record<string, string>) => {
    const { default: h } = await import('node:http');
    return new Promise<number>((resolve, reject) => {
      const req = h.request({ host: '127.0.0.1', port, path: '/api/status', headers }, (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  };
  it('accepts a host name passed with --allow-host, and only that one', async () => {
    const { port } = await start({ allowHosts: ['laptop.tail1234.ts.net'] });
    // What `tailscale serve` forwards: the tailnet name as Host, and the page's own origin.
    expect(await raw(port, { Host: 'laptop.tail1234.ts.net' })).toBe(200);
    expect(await raw(port, { Host: 'laptop.tail1234.ts.net', Origin: 'https://laptop.tail1234.ts.net' })).toBe(200);
    expect(await raw(port, { Host: 'LAPTOP.tail1234.ts.net:443' })).toBe(200);
    expect(await raw(port, { Host: 'other.tail1234.ts.net' })).toBe(403);
    expect(await raw(port, { Host: 'laptop.tail1234.ts.net', Origin: 'https://evil.example' })).toBe(403);
  });
});

describe('a bad request never takes the server down', () => {
  // Raw HTTP: fetch() normalises URLs and cannot send these headers.
  const raw = async (port: number, path: string, headers: Record<string, string> = {}) => {
    const { default: h } = await import('node:http');
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = h.request(
        { host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
        (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  };
  it('answers a malformed path and an opaque Origin, and keeps serving', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
    const { port, call } = await start({ staticDir: dir });
    // What any web page could make the browser send: <img src="http://127.0.0.1:4173/%E0">
    expect((await raw(port, '/%E0')).status).toBe(400);
    expect((await raw(port, '/%zz')).status).toBe(400);
    // Sandboxed iframes and file:// pages send the literal string "null".
    const opaque = await raw(port, '/api/status', { Origin: 'null' });
    expect(opaque.status).toBe(403);
    expect(JSON.parse(opaque.body)).toEqual({ error: 'cross-origin requests are not allowed' });
    expect((await raw(port, '/api/status', { Origin: 'not a url at all' })).status).toBe(403);
    // Still alive and answering.
    expect((await call('GET', '/api/status')).status).toBe(200);
    expect((await raw(port, '/')).status).toBe(200);
  });
  it('survives a client that hangs up in the middle of a request body', async () => {
    const { port, call } = await start();
    const { default: net } = await import('node:net');
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          'POST /api/analyze HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Strikecraft: 1\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"symbol":',
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    expect((await call('GET', '/api/status')).status).toBe(200);
  });
});

describe('a broker whose connection drops mid-order', () => {
  it('says the order may have arrived, and says nothing of the kind for a read', async () => {
    const { default: h } = await import('node:http');
    const dropper = h.createServer((req) => req.socket.destroy());
    servers.push(dropper);
    const port = await listen(dropper, 0);
    const f = makeNodeFetch(3000);
    const sent = await f(`http://127.0.0.1:${port}/v1/accounts/X/orders`, { method: 'POST', body: 'a=1' }).catch(
      (e: Error) => e,
    );
    expect((sent as Error).message).toBe(
      `The connection to 127.0.0.1:${port} failed before it answered. The request may still have reached the broker: check your working and filled orders before sending it again`,
    );
    const read = await f(`http://127.0.0.1:${port}/v1/accounts/X/orders`).catch((e: Error) => e);
    expect((read as Error).message).not.toContain('may still have reached');
  });
});

describe('a broker that stops answering', () => {
  it('fails the call after the deadline with the host named, instead of hanging', async () => {
    const { default: h } = await import('node:http');
    const silent = h.createServer(() => {
      /* never answers */
    });
    servers.push(silent);
    const port = await listen(silent, 0);
    const fetchWithDeadline = makeNodeFetch(150);
    const started = Date.now();
    await expect(fetchWithDeadline(`http://127.0.0.1:${port}/v1/user/profile`)).rejects.toThrow(
      `127.0.0.1:${port} did not answer within 0 s`,
    );
    expect(Date.now() - started).toBeLessThan(3000);
    // An order that timed out may have been received: the error must say so instead of inviting a resend.
    await expect(
      fetchWithDeadline(`http://127.0.0.1:${port}/v1/accounts/X/orders`, { method: 'POST', body: 'a=1' }),
    ).rejects.toThrow(
      'may still have reached the broker: check your working and filled orders before sending it again',
    );
    // Reading the order list places nothing either.
    const listed = await fetchWithDeadline(`http://127.0.0.1:${port}/v1/accounts/X/orders`).catch((e: Error) => e);
    expect((listed as Error).message).toBe(`127.0.0.1:${port} did not answer within 0 s`);
    // A login or a preview places nothing: no order warning for those.
    for (const [path, body] of [
      ['/oauth/token', 'grant_type=refresh_token'],
      ['/accounts/X/orders/dry-run', '{}'],
      ['/v1/accounts/X/orders', 'class=multileg&preview=true'],
    ] as const) {
      const err = await fetchWithDeadline(`http://127.0.0.1:${port}${path}`, { method: 'POST', body }).catch(
        (e: Error) => e,
      );
      expect((err as Error).message).toBe(`127.0.0.1:${port} did not answer within 0 s`);
    }
    silent.closeAllConnections();
  });
});

describe('static UI', () => {
  it('serves the app shell for routes, real files by type, and never leaves its directory', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, '..', 'secret.txt'), 'nope');
    dirs.push(path.join(dir, '..', 'secret.txt'));
    const { base } = await start({ staticDir: dir });
    const shell = await fetch(`${base}/`);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(await shell.text()).toContain('<title>app</title>');
    expect(await (await fetch(`${base}/some/route`)).text()).toContain('<title>app</title>');
    const js = await fetch(`${base}/assets/a.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    const escape = await fetch(`${base}/..%2Fsecret.txt`);
    expect(await escape.text()).not.toContain('nope');
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });
});

describe('key storage', () => {
  it('keeps keys in a file only the user can read, and defaults to live trading off', async () => {
    const dir = path.join(tmp(), 'home');
    const store = fileStore(dir);
    expect(await store.load()).toEqual({ connections: [], settings: { allowLiveOrders: false } });
    await store.save({
      connections: [{ broker: 'tradier', env: 'sandbox', credentials: { token: 'SECRET' }, accountId: 'VA1' }],
      settings: { allowLiveOrders: false },
    });
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect((await store.load()).connections[0]!.credentials.token).toBe('SECRET');
    expect(fs.readdirSync(dir)).toEqual(['config.json']); // no temp file left behind
    // A hand-edited file cannot switch live trading on by accident.
    fs.writeFileSync(store.file, JSON.stringify({ settings: { allowLiveOrders: 'true' } }));
    expect(await store.load()).toEqual({ connections: [], settings: { allowLiveOrders: false } });
    fs.writeFileSync(store.file, '{broken');
    await expect(store.load()).rejects.toThrow();
  });

  it('a broker key leaves the machine only for its own broker, and never appears in an API response', async () => {
    const TOKEN = 'tok_SUPER_SECRET_123';
    const outbound: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchStub: FetchLike = async (url, init) => {
      outbound.push({ url, headers: init?.headers ?? {}, body: init?.body });
      const body = url.endsWith('/user/profile')
        ? { profile: { account: { account_number: 'VA99887766', type: 'margin', option_level: 3, status: 'active' } } }
        : url.includes('/balances')
          ? {
              balances: {
                total_equity: 1000,
                total_cash: 1000,
                margin: { option_buying_power: 1000, stock_buying_power: 2000 },
              },
            }
          : url.includes('/positions')
            ? { positions: 'null' }
            : url.includes('/orders') && init?.method === 'POST'
              ? { order: { id: 9, status: 'ok', cost: 5, commission: 0 } }
              : url.includes('/orders')
                ? { orders: 'null' }
                : {}; // market-data calls: empty → the ladder falls through to the demo rung
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const dir = path.join(tmp(), 'home');
    const { call } = await start({ mode: 'local', fetch: fetchStub, store: fileStore(dir) });
    const responses: unknown[] = [];
    const rec = async (...a: Parameters<typeof call>) => {
      const r = await call(...a);
      responses.push(r.json);
      return r;
    };
    expect(
      (await rec('POST', '/api/connections', { broker: 'tradier', env: 'sandbox', credentials: { token: TOKEN } }))
        .status,
    ).toBe(200);
    // Exercise every route with the broker connected.
    await rec('GET', '/api/status');
    await rec('GET', '/api/quote?symbol=NVDA');
    await rec('GET', '/api/expirations?symbol=NVDA');
    await rec('GET', '/api/chain?symbol=NVDA&expiry=2026-12-18');
    await rec('POST', '/api/analyze', { symbol: 'NVDA', legs: [LEG] });
    await rec('POST', '/api/earnings', { symbol: 'NVDA', legs: [LEG] });
    await rec('GET', '/api/account');
    const order = {
      underlying: 'NVDA',
      type: 'limit',
      price: 0.05,
      duration: 'day',
      legs: [{ symbol: 'NVDA261218C00185000', side: 'buy_to_open', quantity: 1 }],
    };
    await rec('POST', '/api/orders/preview', order);
    await rec('POST', '/api/orders', order);
    await rec('DELETE', '/api/orders/9');
    await rec('PUT', '/api/settings', { allowLiveOrders: false });

    expect(outbound.length).toBeGreaterThan(8);
    for (const o of outbound) {
      const carriesKey = JSON.stringify(o).includes(TOKEN);
      // Every request that carries the key goes to the Tradier sandbox over TLS, in the auth header only.
      if (carriesKey) {
        expect(new URL(o.url).host).toBe('sandbox.tradier.com');
        expect(new URL(o.url).protocol).toBe('https:');
        expect(o.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(o.url).not.toContain(TOKEN);
        expect(o.body ?? '').not.toContain(TOKEN);
      }
      // ...and nothing goes anywhere else at all.
      expect(new URL(o.url).host).toBe('sandbox.tradier.com');
    }
    expect(JSON.stringify(responses)).not.toContain(TOKEN);
    expect(JSON.stringify(responses)).not.toContain('VA99887766');
    // On disk: present (it has to be), in the 0600 file and nowhere else in the data dir.
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600);
    await rec('DELETE', '/api/connections/tradier');
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).not.toContain(TOKEN);
  });
});

describe('command line', () => {
  it('parses options with safe defaults', () => {
    const d = parseArgs([], {});
    expect(d).toMatchObject({ port: 4173, host: '127.0.0.1', demo: false, open: true });
    expect(
      parseArgs(['--port', '0', '--host', '0.0.0.0', '--demo', '--no-open', '--allow-host', 'box.tail.ts.net'], {}),
    ).toMatchObject({
      port: 0,
      host: '0.0.0.0',
      demo: true,
      open: false,
      allowHosts: ['box.tail.ts.net'],
    });
    expect(parseArgs([], { STRIKECRAFT_PORT: '5000', STRIKECRAFT_DEMO: '1' })).toMatchObject({
      port: 5000,
      demo: true,
    });
    expect(() => parseArgs(['--port'], {})).toThrow('--port needs a value');
    expect(() => parseArgs(['--port', '99999'], {})).toThrow('from 0 to 65535');
    expect(() => parseArgs(['--frobnicate'], {})).toThrow('unknown option --frobnicate');
    expect(HELP).toContain('Keys stay on this machine');
  });
  it('demo mode builds a service that needs no network or disk', async () => {
    const o = serviceOptions({ demo: true, dataDir: '/nonexistent/never-created' });
    expect(o.mode).toBe('demo');
    const svc = await createService(o);
    expect((await svc.quote('SPY')).source.source).toBe('demo');
    expect(fs.existsSync('/nonexistent/never-created')).toBe(false);
  });
});
