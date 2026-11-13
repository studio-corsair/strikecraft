#!/usr/bin/env node
// Live check of the Tradier adapter against the SANDBOX (paper money, never a live account):
// accounts → balances → quote → chain → preview a 2-leg vertical → place it → see it working →
// cancel it → see it canceled. Exits 1 if any step fails.
//
//   node packages/data/scripts/tradier-sandbox.ts [SYMBOL] [--record <dir>]
//
// Token: TRADIER_SANDBOX_TOKEN, else ~/.secrets/tradier_sandbox_api_key.
// --record writes every request/response pair (account number, name and token scrubbed) to
// <dir>/tradier-sandbox.json: the fixture the contract tests replay.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tradierBroker, TRADIER_HOSTS } from '../src/broker/tradier.ts';
import type { FetchLike, OrderRequest } from '../src/broker/types.ts';
import { occ } from '../src/symbols.ts';

const args = process.argv.slice(2);
const recordDir = args.includes('--record') ? args[args.indexOf('--record') + 1] : null;
const sym = (args.find((a) => !a.startsWith('--') && a !== recordDir) ?? 'NVDA').toUpperCase();

const tokenFile = path.join(os.homedir(), '.secrets', 'tradier_sandbox_api_key');
const token =
  process.env.TRADIER_SANDBOX_TOKEN ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
if (!token) {
  console.error('no sandbox token: set TRADIER_SANDBOX_TOKEN or write ~/.secrets/tradier_sandbox_api_key');
  process.exit(1);
}

type Rec = { method: string; url: string; body: string | null; status: number; response: string };
const recorded: Rec[] = [];
const hostsSeen = new Set<string>();
const recordingFetch: FetchLike = async (url, init) => {
  hostsSeen.add(new URL(url).host);
  const res = await fetch(url, init);
  const text = await res.text();
  recorded.push({ method: init?.method ?? 'GET', url, body: init?.body ?? null, status: res.status, response: text });
  return { ok: res.ok, status: res.status, text: async () => text };
};

const broker = tradierBroker({ token, env: 'sandbox', fetch: recordingFetch });
const step = async <T>(name: string, fn: () => Promise<T>, show: (x: T) => string): Promise<T> => {
  const out = await fn();
  console.log(`${name.padEnd(16)} ${show(out)}`);
  return out;
};

let exit = 0;
try {
  const accounts = await step(
    'accounts',
    () => broker.accounts(),
    (a) => `${a.length} account(s), option level ${a[0]?.optionLevel}, ${a[0]?.type}`,
  );
  const acct = accounts[0]!.id;
  await step(
    'balances',
    () => broker.balances(acct),
    (b) => `equity $${b.equity.toFixed(2)}, option buying power $${b.optionBuyingPower?.toFixed(2)}`,
  );
  await step(
    'positions',
    () => broker.positions(acct),
    (p) => `${p.length} position(s)`,
  );
  const md = broker.marketData();
  const q = await step(
    'quote',
    () => md.quote!(sym),
    (x) =>
      `${sym} last=${x.lastPrice} session=${x.session} source=${x.source} delayed=${x.delayed} delayMinutes=${x.delayMinutes}`,
  );
  const exps = await step(
    'expirations',
    () => md.expirations!(sym),
    (e) => `${e.expirations.length} expiries`,
  );
  // A monthly ~5 weeks out, and a far out-of-the-money call vertical priced at 1 cent so it cannot fill.
  const expiry = exps.expirations.find((d) => (Date.parse(d) - Date.now()) / 864e5 > 30) ?? exps.expirations.at(-1)!;
  const chain = await step(
    'chain',
    () => md.optionChain!(sym, expiry),
    (c) => `${expiry}: ${c.calls.length} calls, ${c.puts.length} puts, source=${c.source}`,
  );
  const otm = chain.calls.filter((c) => c.strike > q.lastPrice * 1.25);
  const [long, short] = [otm[0]!, otm[1]!];
  const order: OrderRequest = {
    underlying: sym,
    type: 'debit',
    price: 0.01,
    duration: 'day',
    tag: 'strikebench-sandbox-check',
    legs: [
      { symbol: occ(sym, expiry, 'C', long.strike), side: 'buy_to_open', quantity: 1 },
      { symbol: occ(sym, expiry, 'C', short.strike), side: 'sell_to_open', quantity: 1 },
    ],
  };
  console.log(`order            ${sym} ${expiry} +1 C ${long.strike} / -1 C ${short.strike} debit 0.01 day (2 legs)`);
  const preview = await step(
    'preview',
    () => broker.previewOrder(acct, order),
    (p) => `ok=${p.ok} cost=${p.cost} commission=${p.commission} marginChange=${p.marginChange}`,
  );
  if (!preview.ok) throw new Error('preview was not ok');
  const placed = await step(
    'place',
    () => broker.placeOrder(acct, order),
    (p) => `id=${p.id} state=${p.state}`,
  );
  const find = async () => (await broker.orders(acct)).find((o) => o.id === placed.id);
  const working = await step('order status', find, (o) =>
    o ? `id=${o.id} state=${o.state} legs=${o.legs.length} type=${o.type} price=${o.price}` : 'NOT FOUND',
  );
  if (!working) throw new Error('placed order not found in the order list');
  const cancel = await step(
    'cancel',
    () => broker.cancelOrder(acct, placed.id),
    (c) => `id=${c.id} ok=${c.ok}`,
  );
  if (!cancel.ok) throw new Error('cancel was not ok');
  // The sandbox applies cancels asynchronously; give it a moment.
  let after = await find();
  for (let i = 0; i < 10 && after && after.state !== 'canceled'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await find();
  }
  console.log(
    `${'after cancel'.padEnd(16)} ${after ? `id=${after.id} state=${after.state}` : 'order no longer listed'}`,
  );
  if (after && after.state !== 'canceled') throw new Error(`order is ${after.state}, expected canceled`);
  console.log(`${'hosts contacted'.padEnd(16)} ${[...hostsSeen].join(', ')} (allowed: ${broker.hosts.join(', ')})`);
  if ([...hostsSeen].some((h) => h !== TRADIER_HOSTS.sandbox)) throw new Error('a request left the sandbox host');
  console.log('SANDBOX CHECK PASS: preview + place + cancel of a multi-leg order, sandbox only, no live order');
} catch (e) {
  exit = 1;
  console.error(`SANDBOX CHECK FAIL: ${(e as Error).message}`);
}

if (recordDir) {
  const acctIds = new Set<string>();
  for (const r of recorded) for (const m of r.url.matchAll(/\/accounts\/([^/?]+)/g)) acctIds.add(m[1]!);
  const scrub = (s: string | null) => {
    if (s == null) return s;
    let out = s.split(token).join('SCRUBBED_TOKEN');
    for (const id of acctIds) out = out.split(id).join('VA00000000');
    return out
      .replace(/"name":\s*"[^"]*"/g, '"name":"Demo User"')
      .replace(/"id":\s*"id-[^"]*"/g, '"id":"id-sb-demo"')
      .replace(/"root_symbols":\s*"[^"]*"/g, '"root_symbols":"' + sym + '"');
  };
  // Keep the fixture small: chains trimmed to the strikes the check used ±, everything else whole.
  const out = recorded.map((r) => {
    let response = scrub(r.response)!;
    if (r.url.includes('/markets/options/chains')) {
      const j = JSON.parse(response);
      const all = j.options.option as { strike: number }[];
      const strikes = [...new Set(all.map((o) => o.strike))].sort((a, b) => a - b);
      const keep = new Set(
        strikes.filter((_, i) => i % Math.ceil(strikes.length / 12) === 0).concat(strikes.slice(-6)),
      );
      j.options.option = all.filter((o) => keep.has(o.strike));
      response = JSON.stringify(j);
    }
    return { method: r.method, url: scrub(r.url), body: scrub(r.body), status: r.status, response };
  });
  fs.mkdirSync(recordDir, { recursive: true });
  const file = path.join(recordDir, 'tradier-sandbox.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`recorded ${out.length} exchanges → ${file}`);
}
process.exit(exit);
