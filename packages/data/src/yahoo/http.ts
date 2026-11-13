// Minimal fetch-alike that can tunnel through a SOCKS5 proxy (RFC 1928 + RFC 1929 user/pass),
// with zero dependencies — Node 20's global fetch cannot use a proxy. The house rule: anything that
// scrapes a third party repeatedly (the daily chain logger) goes through a proxy, never our own IP.
//   OPT_PROXY=socks5h://user:pass@host:1080   → every request tunnels (DNS resolved by the proxy)
//   (or OPT_PROXY=socks5h://host:1080 plus OPT_PROXY_USER / OPT_PROXY_PASS)
//   unset                                      → plain global fetch
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

/** Free-form third-party JSON payload (Yahoo / SEC): only the fields actually read are touched. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export type Resp = {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null; getSetCookie: () => string[] };
  text: () => Promise<string>;
  json: () => Promise<Json>;
};

/** Open a TCP stream to host:port through a SOCKS5 proxy. */
export function socksConnect(proxy: URL, host: string, port: number, timeoutMs = 15000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxy.port || 1080), proxy.hostname);
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('SOCKS5 timeout')));
    let buf: Buffer = Buffer.alloc(0);
    let want: ((b: Buffer) => void) | null = null;
    let need = 0;
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      drain();
    });
    sock.on('error', reject);
    const drain = () => {
      if (want && buf.length >= need) {
        const chunk = buf.subarray(0, need);
        buf = buf.subarray(need);
        const w = want;
        want = null;
        w(chunk);
      }
    };
    const read = (n: number): Promise<Buffer> =>
      new Promise((res) => {
        want = res;
        need = n;
        drain();
      });
    // Credentials from the URL, or OPT_PROXY_USER / OPT_PROXY_PASS (no URL-encoding headaches).
    const user = decodeURIComponent(proxy.username) || process.env.OPT_PROXY_USER || '';
    const pass = decodeURIComponent(proxy.password) || process.env.OPT_PROXY_PASS || '';
    (async () => {
      sock.write(Buffer.from(user ? [5, 1, 2] : [5, 1, 0]));
      const [ver, method] = await read(2);
      if (ver !== 5 || method === 0xff) throw new Error('SOCKS5: no acceptable auth method');
      if (method === 2) {
        const u = Buffer.from(user),
          p = Buffer.from(pass);
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        const [, st] = await read(2);
        if (st !== 0) throw new Error('SOCKS5: proxy rejected the username/password');
      }
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
      const head = await read(4);
      if (head[1] !== 0) throw new Error(`SOCKS5: connect to ${host}:${port} failed (code ${head[1]})`);
      const atyp = head[3];
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : ((await read(1))[0] ?? 0);
      await read(addrLen + 2);
      sock.setTimeout(0);
      sock.removeAllListeners('data');
      if (buf.length) sock.unshift(buf);
      resolve(sock);
    })().catch((e) => {
      sock.destroy();
      reject(e);
    });
  });
}

/** GET (or other method) returning a fetch-like response. Follows up to 3 redirects. */
export async function httpFetch(
  url: string,
  init: { headers?: Record<string, string>; method?: string } = {},
  proxyUrl: string | undefined = process.env.OPT_PROXY,
  hops = 0,
): Promise<Resp> {
  if (!proxyUrl) return fetch(url, init) as unknown as Promise<Resp>;
  const proxy = new URL(proxyUrl);
  if (!/^socks5h?:$/.test(proxy.protocol))
    throw new Error(`OPT_PROXY must be socks5h://user:pass@host:port (got ${proxy.protocol})`);
  const u = new URL(url),
    secure = u.protocol === 'https:';
  const port = Number(u.port || (secure ? 443 : 80));
  const raw = await socksConnect(proxy, u.hostname, port);
  const socket = secure ? tls.connect({ socket: raw, servername: u.hostname }) : raw;
  const lib = secure ? https : http;
  const res: http.IncomingMessage = await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: { ...init.headers, Connection: 'close' },
        agent: false,
        createConnection: () => socket,
      },
      resolve,
    );
    req.setTimeout(30000, () => req.destroy(new Error(`timeout ${u.hostname}`)));
    req.on('error', reject);
    req.end();
  });
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400 && res.headers.location && hops < 3) {
    res.resume();
    return httpFetch(new URL(res.headers.location, url).toString(), init, proxyUrl, hops + 1);
  }
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const sc = res.headers['set-cookie'] ?? [];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => {
        const v = res.headers[k.toLowerCase()];
        return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v);
      },
      getSetCookie: () => sc,
    },
    text: async () => body,
    json: async () => JSON.parse(body) as Json,
  };
}
