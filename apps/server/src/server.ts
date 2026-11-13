// The local Strikecraft server: serves the UI and answers /api/* from the service. It runs on
// the user's own machine; broker and market-data calls go out from here, never through a server
// of ours.
//
// Because it holds broker keys, every /api request must look like it came from our own page:
//   - the Host header must be one this server was started for (stops DNS-rebinding);
//   - an Origin header, when present, must match that Host;
//   - anything that is not a GET must carry `X-Strikecraft: 1` and a JSON content type, which a
//     cross-site form or a no-CORS fetch cannot send (we never answer CORS preflights).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Service } from '@strikecraft/data';
import { createApi } from './app.ts';

export interface ServerOptions {
  service: Service;
  port: number;
  /** 127.0.0.1 by default; 0.0.0.0 to reach it from a phone on the LAN or tailnet. */
  host?: string;
  /** Built web app directory (index.html + assets). */
  staticDir?: string;
  /** Extra hostnames to accept in the Host header (a tailnet name, a LAN alias). */
  allowHosts?: string[];
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 256 * 1024;

/** Hostnames this machine answers to: loopback, its own name, and every local interface address. */
export function localHostnames(extra: string[] = []): Set<string> {
  const names = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    os.hostname().toLowerCase(),
    ...extra.map((h) => h.toLowerCase()),
  ]);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) names.add(a.family === 'IPv6' ? `[${a.address}]` : a.address);
  return names;
}

export function hostAllowed(hostHeader: string | undefined, allowed: Set<string>): boolean {
  if (!hostHeader) return false;
  const name = hostHeader.toLowerCase().replace(/:\d+$/, '');
  return allowed.has(name);
}

export function createServer(o: ServerOptions): http.Server {
  const api = createApi(o.service);
  const loopbackOnly = (o.host ?? '127.0.0.1') === '127.0.0.1';
  const allowed = loopbackOnly
    ? new Set(['localhost', '127.0.0.1', '[::1]', ...(o.allowHosts ?? []).map((h) => h.toLowerCase())])
    : localHostnames(o.allowHosts);

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  };

  function serveStatic(urlPath: string, res: http.ServerResponse) {
    if (!o.staticDir) return send(res, 404, { error: 'the UI is not built: run `npm run build`' });
    const root = path.resolve(o.staticDir);
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
    } catch {
      return send(res, 400, { error: 'the path is not valid percent-encoding' }); // error-ok: answered with a 400; a malformed URL is the client's error
    }
    let file = path.resolve(root, rel || 'index.html');
    // Never serve outside the UI directory; unknown paths get the app shell (client-side routes).
    if (!file.startsWith(root + path.sep) && file !== root) file = path.join(root, 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) return send(res, 404, { error: `not found: ${urlPath}` });
      file = path.join(root, 'index.html');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    const stream = fs.createReadStream(file);
    // The file can vanish between the check and the read (a rebuild): end the response, keep serving.
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /** Host of an Origin header, or null when it is not a URL (sandboxed pages send the string "null"). */
  const originHost = (origin: string): string | null => {
    try {
      return new URL(origin).host.toLowerCase();
    } catch {
      return null; // error-ok: an unparseable Origin is treated as a foreign origin and refused
    }
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (!hostAllowed(req.headers.host, allowed)) return send(res, 403, { error: 'this host name is not allowed' });
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return serveStatic(url.pathname, res);
    }
    const origin = req.headers.origin;
    if (origin && originHost(origin) !== (req.headers.host ?? '').toLowerCase())
      return send(res, 403, { error: 'cross-origin requests are not allowed' });
    let body: unknown = undefined;
    if (method !== 'GET') {
      if (req.headers['x-strikecraft'] !== '1') return send(res, 403, { error: 'missing X-Strikecraft header' });
      if (method !== 'DELETE' && !String(req.headers['content-type'] ?? '').startsWith('application/json'))
        return send(res, 415, { error: 'the body must be application/json' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return send(res, 413, { error: 'request body too large' });
        chunks.push(c as Buffer);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (e) {
          return send(res, 400, { error: `the body is not valid JSON: ${(e as Error).message}` });
        }
      }
    }
    const out = await api({ method, path: url.pathname, query: url.searchParams, body });
    send(res, out.status, out.body);
  }

  // Nothing a request does may take the server down: it holds the user's broker session. Any
  // error that escapes a handler (a malformed URL, a client that hangs up mid-upload) is answered
  // with a 400 or 500 where a response is still possible, and logged.
  return http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`request failed: ${req.method} ${req.url}: ${message}`);
      if (res.headersSent || res.writableEnded) return res.destroy();
      send(res, e instanceof TypeError || e instanceof URIError ? 400 : 500, { error: `request failed: ${message}` });
    });
  });
}

export function listen(server: http.Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    });
  });
}
