// `strikecraft` command: start the local server and open the UI.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createService, memoryStore, demoSource, defaultDemoSnapshots, cboeSource } from '@strikecraft/data';
import type { FetchLike, MarketDataSource, ServiceOptions } from '@strikecraft/data';
import { yahooSource, httpFetch } from '@strikecraft/data/node';
import { createServer, listen } from './server.ts';
import { fileStore, defaultDataDir } from './store.ts';

export const VERSION = '0.1.0';

export interface CliOptions {
  port: number;
  host: string;
  demo: boolean;
  open: boolean;
  dataDir: string;
  staticDir: string | null;
  allowHosts: string[];
  help: boolean;
  version: boolean;
}

export const HELP = `Strikecraft ${VERSION}: an options workstation that runs on your own broker key.

Usage: strikecraft [options]

  --port <n>         Port to listen on (default 4173; 0 picks a free one)
  --host <addr>      Address to bind (default 127.0.0.1). Use 0.0.0.0 to open it to your
                     phone on the same network or tailnet.
  --allow-host <h>   Extra host name to accept (a tailnet or LAN name). Repeatable.
  --demo             Run on built-in simulated data: no network, no broker.
  --data-dir <dir>   Where keys and settings are kept (default ~/.strikecraft, mode 0600)
  --no-open          Do not open the browser
  --version, --help

Keys stay on this machine. They are sent only to the broker they belong to.`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const o: CliOptions = {
    port: Number(env.STRIKECRAFT_PORT ?? 4173),
    host: env.STRIKECRAFT_HOST ?? '127.0.0.1',
    demo: env.STRIKECRAFT_DEMO === '1',
    open: true,
    dataDir: defaultDataDir(),
    staticDir: null,
    allowHosts: [],
    help: false,
    version: false,
  };
  const need = (i: number, flag: string) => {
    const v = argv[i];
    if (v == null || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') o.port = Number(need(++i, a));
    else if (a === '--host') o.host = need(++i, a);
    else if (a === '--allow-host') o.allowHosts.push(need(++i, a));
    else if (a === '--data-dir') o.dataDir = need(++i, a);
    else if (a === '--static') o.staticDir = need(++i, a);
    else if (a === '--demo') o.demo = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535)
    throw new Error('--port must be a number from 0 to 65535');
  return o;
}

/**
 * Global fetch as the minimal shape broker adapters take, with a deadline: a broker that stops
 * answering fails the request with a clear error instead of hanging every screen that uses it.
 */
const RESEND_WARNING =
  'The request may still have reached the broker: check your working and filled orders before sending it again';

/** True when a request that got no answer could still have placed, changed or canceled an order. */
function mayHaveActed(url: string, init?: { method?: string; body?: string }): boolean {
  if ((init?.method ?? 'GET') === 'GET') return false;
  const path = new URL(url).pathname;
  if (!/\/orders(\/|$)/.test(path) || path.endsWith('/dry-run')) return false; // logins, previews
  return !/(^|[?&])preview=true(&|$)/.test(init?.body ?? '');
}

export const makeNodeFetch =
  (timeoutMs = 15_000): FetchLike =>
  async (url, init) => {
    try {
      const res = await fetch(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text: async () => text };
    } catch (e) {
      const host = new URL(url).host;
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      // A write may have arrived even though no answer came back (deadline passed, connection dropped
      // mid-response): never invite a blind resend.
      const acted = mayHaveActed(url, init) ? `. ${RESEND_WARNING}` : '';
      if (timedOut)
        throw new Error(`${host} did not answer within ${Math.round(timeoutMs / 1000)} s${acted}`, { cause: e });
      if (acted) throw new Error(`The connection to ${host} failed before it answered${acted}`, { cause: e });
      throw e;
    }
  };
export const nodeFetch: FetchLike = makeNodeFetch();

export function serviceOptions(o: Pick<CliOptions, 'demo' | 'dataDir'>): ServiceOptions {
  const deps = { fetch: nodeFetch, WebSocket: globalThis.WebSocket as unknown as ServiceOptions['deps']['WebSocket'] };
  if (o.demo) {
    const demo = demoSource(defaultDemoSnapshots());
    return {
      mode: 'demo',
      baseSources: [demo],
      store: memoryStore(),
      deps,
      engine: { now: () => demo.asOf },
      demo: { simulated: demo.simulated, symbols: demo.symbols, asOf: demo.asOf },
      version: VERSION,
    };
  }
  const fetchJson = async (url: string) => {
    const res = await httpFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  };
  const sources: MarketDataSource[] = [yahooSource(), cboeSource(fetchJson)];
  return { mode: 'local', baseSources: sources, store: fileStore(o.dataDir), deps, version: VERSION };
}

function findStaticDir(explicit: string | null): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, path.join(here, 'web'), path.join(here, '../web'), path.join(here, '../../web/dist')];
  return candidates.find((d): d is string => !!d && fs.existsSync(path.join(d, 'index.html'))) ?? null;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`)); // error-ok: no opener on this system; the URL is printed instead
  child.unref();
}

export async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  if (o.help) return void console.log(HELP);
  if (o.version) return void console.log(VERSION);
  const service = await createService(serviceOptions(o));
  const staticDir = findStaticDir(o.staticDir);
  const server = createServer({
    service,
    port: o.port,
    host: o.host,
    staticDir: staticDir ?? undefined,
    allowHosts: o.allowHosts,
  });
  const port = await listen(server, o.port, o.host);
  const local = `http://localhost:${port}`;
  console.log(`Strikecraft ${VERSION} is running: ${local}`);
  console.log(
    o.demo
      ? 'Mode: demo (simulated data, nothing leaves this machine).'
      : `Mode: local. Keys and settings: ${o.dataDir} (only you can read it).`,
  );
  if (o.host !== '127.0.0.1') {
    const addrs = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => `http://${a!.address}:${port}`);
    console.log(`On your phone (same network or tailnet): ${addrs.join('  ')}`);
    console.log(
      'Anyone who can reach this address can use your connected broker. Only do this on a network you trust.',
    );
  }
  if (!staticDir) console.log('The UI is not built; only /api is being served.');
  if (o.open && staticDir) openBrowser(local);
}
