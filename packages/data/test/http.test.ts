import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { httpFetch } from '../src/yahoo/http.ts';

// A local HTTP origin plus a local SOCKS5 server with user/pass auth (RFC 1928/1929).
let origin: http.Server,
  socks: net.Server,
  originPort = 0,
  socksPort = 0;
const seen: string[] = [];

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/json' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['A=1; Path=/', 'B=2; Path=/'] });
    res.end(JSON.stringify({ path: req.url, ua: req.headers['user-agent'] }));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as net.AddressInfo).port;

  socks = net.createServer((c) => {
    let stage = 0,
      buf = Buffer.alloc(0);
    c.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(2 + buf[1]!);
        c.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1]!,
          user = buf.subarray(2, 2 + ul).toString(),
          pl = buf[2 + ul]!,
          pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        const ok = user === 'u' && pass === 'p';
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return c.end();
        stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        const hl = buf[4]!,
          host = buf.subarray(5, 5 + hl).toString(),
          port = buf.readUInt16BE(5 + hl);
        seen.push(`${host}:${port}`);
        buf = buf.subarray(7 + hl);
        stage = 3;
        const up = net.connect(port, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buf.length) up.write(buf);
          c.pipe(up).pipe(c);
        });
        c.removeAllListeners('data');
      }
    });
  });
  await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r));
  socksPort = (socks.address() as net.AddressInfo).port;
});
afterAll(() => {
  origin.close();
  socks.close();
});

describe('SOCKS5 tunnelling fetch', () => {
  it('tunnels through the proxy with user/pass, proxy-side DNS, and returns headers + body', async () => {
    const r = await httpFetch(
      `http://localhost:${originPort}/json?x=1`,
      { headers: { 'User-Agent': 'probe' } },
      `socks5h://u:p@127.0.0.1:${socksPort}`,
    );
    expect(r.ok).toBe(true);
    expect(await r.json()).toEqual({ path: '/json?x=1', ua: 'probe' });
    expect(r.headers.getSetCookie()).toHaveLength(2);
    expect(seen.at(-1)).toBe(`localhost:${originPort}`); // hostname sent to the proxy, not resolved locally
  });
  it('follows redirects through the tunnel', async () => {
    const r = await httpFetch(`http://localhost:${originPort}/redirect`, {}, `socks5h://u:p@127.0.0.1:${socksPort}`);
    expect((await r.json()).path).toBe('/json');
  });
  it('fails loudly on bad credentials (no silent direct fallback)', async () => {
    await expect(
      httpFetch(`http://localhost:${originPort}/json`, {}, `socks5h://u:WRONG@127.0.0.1:${socksPort}`),
    ).rejects.toThrow(/rejected/);
  });
});
