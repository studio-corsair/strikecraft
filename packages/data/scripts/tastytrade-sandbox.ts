#!/usr/bin/env node
// Live check of the tastytrade adapter against the CERTIFICATION sandbox (simulated money, never a
// live account): accounts → balances → positions → expirations → chain → dry-run a 2-leg vertical →
// place it → see it working → cancel it → see it canceled. Exits 1 if any step fails.
//
//   node packages/data/scripts/tastytrade-sandbox.ts [SYMBOL]
//
// Credentials (a SANDBOX OAuth application; production credentials do not work here):
//   TASTYTRADE_CERT_CLIENT_SECRET + TASTYTRADE_CERT_REFRESH_TOKEN  (+ optional TASTYTRADE_CERT_CLIENT_ID)
//   or TASTYTRADE_CERT_ACCESS_TOKEN (a 15-minute token; fine for a single run)
// Create the sandbox user, funded account, OAuth app and grant with the browser tool at
// https://developer.tastytrade.com/docs/sandbox/tools . tastytrade decommissioned the old
// login + password session flow on 2026-02-11, so there is no password variable.
// Note: the sandbox has no REST quotes (/market-data answers 502), so the strikes are picked from
// the nested chain structure alone: a far-from-the-money vertical at 1 cent that cannot fill.
//
//   --record <dir>  writes every request/response pair (tokens, account number and names scrubbed)
//                   to <dir>/tastytrade-sandbox.json, for turning into contract-test fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { tastytradeBroker, toStreamerSymbol, TASTYTRADE_HOSTS } from '../src/broker/tastytrade.ts';
import type { TastytradeAuth } from '../src/broker/tastytrade.ts';
import type { FetchLike, OrderRequest } from '../src/broker/types.ts';

const args = process.argv.slice(2);
const recordDir = args.includes('--record') ? args[args.indexOf('--record') + 1]! : null;
const sym = (args.find((a) => !a.startsWith('--') && a !== recordDir) ?? 'NVDA').toUpperCase();
const env = process.env;
const auth: TastytradeAuth | null =
  env.TASTYTRADE_CERT_REFRESH_TOKEN && env.TASTYTRADE_CERT_CLIENT_SECRET
    ? {
        refreshToken: env.TASTYTRADE_CERT_REFRESH_TOKEN,
        clientSecret: env.TASTYTRADE_CERT_CLIENT_SECRET,
        ...(env.TASTYTRADE_CERT_CLIENT_ID ? { clientId: env.TASTYTRADE_CERT_CLIENT_ID } : {}),
      }
    : env.TASTYTRADE_CERT_ACCESS_TOKEN
      ? { accessToken: env.TASTYTRADE_CERT_ACCESS_TOKEN }
      : null;
if (!auth) {
  console.error(
    'no sandbox credentials: set TASTYTRADE_CERT_REFRESH_TOKEN + TASTYTRADE_CERT_CLIENT_SECRET ' +
      '(optionally TASTYTRADE_CERT_CLIENT_ID), or TASTYTRADE_CERT_ACCESS_TOKEN',
  );
  process.exit(1);
}

type Rec = { method: string; url: string; body: string | null; status: number; response: string };
const recorded: Rec[] = [];
const hostsSeen = new Set<string>();
const trackingFetch: FetchLike = async (url, init) => {
  hostsSeen.add(new URL(url).host);
  const res = await fetch(url, init);
  const text = await res.text();
  recorded.push({
    method: init?.method ?? 'GET',
    url,
    body: (init?.body as string | undefined) ?? null,
    status: res.status,
    response: text,
  });
  return { ok: res.ok, status: res.status, text: async () => text };
};

const broker = tastytradeBroker({
  auth,
  env: 'sandbox',
  fetch: trackingFetch,
  WebSocket: globalThis.WebSocket as unknown as NonNullable<Parameters<typeof tastytradeBroker>[0]['WebSocket']>,
});
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
    (a) => `${a.length} account(s), ${a[0]?.type}, ${a[0]?.status}`,
  );
  const acct = accounts.find((a) => a.status === 'active')?.id;
  if (!acct) throw new Error('no active sandbox account');
  await step(
    'balances',
    () => broker.balances(acct),
    (b) => `equity $${b.equity.toFixed(2)}, derivative buying power $${b.optionBuyingPower?.toFixed(2)}`,
  );
  await step(
    'positions',
    () => broker.positions(acct),
    (p) => `${p.length} position(s)`,
  );
  const exps = await step(
    'expirations',
    () => broker.marketData().expirations!(sym),
    (e) => `${e.expirations.length} expiries`,
  );
  // A monthly ~5 weeks out.
  const expiry = exps.expirations.find((d) => (Date.parse(d) - Date.now()) / 864e5 > 30) ?? exps.expirations.at(-1)!;
  const strikes = await step(
    'chain',
    () => broker.chainStructure(sym, expiry),
    (c) => `${expiry}: ${c.length} strikes ${c[0]?.strike}..${c.at(-1)?.strike}`,
  );
  // The derived streamer symbol (used when the chain has not been read) against the broker's own.
  const mism = strikes.filter(
    (r) => toStreamerSymbol(r.call) !== r.callStreamer || toStreamerSymbol(r.put) !== r.putStreamer,
  );
  console.log(
    `${'streamer symbols'.padEnd(16)} derived == broker's on ${strikes.length - mism.length}/${strikes.length} strikes` +
      (mism[0] ? ` (e.g. derived ${toStreamerSymbol(mism[0].call)} vs broker ${mism[0].callStreamer})` : ''),
  );
  // Without a quote, the highest strikes are the furthest out of the money for a call vertical.
  const [short, long] = strikes.slice(-2).reverse();
  if (!long || !short) throw new Error('the chain has fewer than two strikes');
  const order: OrderRequest = {
    underlying: sym,
    type: 'debit',
    price: 0.01,
    duration: 'day',
    tag: 'strikecraft-sandbox-check',
    legs: [
      { symbol: long.call, side: 'buy_to_open', quantity: 1 },
      { symbol: short.call, side: 'sell_to_open', quantity: 1 },
    ],
  };
  console.log(`order            ${sym} ${expiry} +1 C ${long.strike} / -1 C ${short.strike} debit 0.01 day (2 legs)`);
  const preview = await step(
    'dry-run',
    () => broker.previewOrder(acct, order),
    (p) =>
      `ok=${p.ok} cost=${p.cost} commission=${p.commission} marginChange=${p.marginChange} warnings=${p.warnings.length}`,
  );
  if (!preview.ok) throw new Error(`dry-run was not ok: ${preview.warnings.join('; ')}`);
  // Informational: how does the sandbox treat an "even" (zero-priced limit) spread? Dry-run only.
  try {
    const even = await broker.previewOrder(acct, { ...order, type: 'even', price: undefined });
    console.log(`${'dry-run even'.padEnd(16)} ok=${even.ok} warnings=${even.warnings.join(' | ') || 'none'}`);
  } catch (e) {
    // error-ok: an informational probe; whether the sandbox accepts an even spread is the result being printed
    console.log(`${'dry-run even'.padEnd(16)} rejected: ${(e as Error).message.slice(0, 160)}`);
  }
  // Informational: a rejected dry-run (a leg whose strike does not exist), to record the real error body.
  try {
    await broker.previewOrder(acct, {
      ...order,
      legs: [{ symbol: long.call.replace(/\d{8}$/, '01931000'), side: 'buy_to_open', quantity: 1 }, order.legs[1]!],
    });
    console.log(`${'dry-run reject'.padEnd(16)} NOT rejected (unexpected)`);
  } catch (e) {
    // error-ok: the rejection is the expected outcome of this probe, and its message is what gets recorded
    console.log(`${'dry-run reject'.padEnd(16)} ${(e as Error).message.slice(0, 200)}`);
  }
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
  // Cancels are confirmed asynchronously ("Cancel Requested" -> "Cancelled"); give it a moment.
  let after = await find();
  for (let i = 0; i < 10 && after && after.state !== 'canceled'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await find();
  }
  console.log(
    `${'after cancel'.padEnd(16)} ${after ? `id=${after.id} state=${after.state}` : 'order no longer listed'}`,
  );
  if (after && after.state !== 'canceled') throw new Error(`order is ${after.state}, expected canceled`);
  // Informational: DXLink streaming. A failure here is reported, not fatal (the sandbox feed is delayed/demo).
  await new Promise<void>((resolve) => {
    let n = 0;
    const t = setTimeout(done, 10_000);
    let stop: (() => void) | undefined;
    function done() {
      clearTimeout(t);
      stop?.();
      console.log(`${'stream'.padEnd(16)} ${n} quote update(s) for ${long!.call} in 10s`);
      resolve();
    }
    broker
      .stream(
        ['NVDA', long!.call],
        () => (++n === 3 ? done() : undefined),
        (e) => console.log(`${'stream'.padEnd(16)} error: ${e.message}`),
      )
      .then((s) => (stop = s))
      .catch((e: Error) => {
        console.log(`${'stream'.padEnd(16)} failed: ${e.message}`);
        resolve();
      });
  });
  console.log(`${'hosts contacted'.padEnd(16)} ${[...hostsSeen].join(', ')} (allowed: ${broker.hosts.join(', ')})`);
  if ([...hostsSeen].some((h) => h !== TASTYTRADE_HOSTS.sandbox)) throw new Error('a request left the sandbox host');
  console.log('SANDBOX CHECK PASS: dry-run + place + cancel of a multi-leg order, cert sandbox only, no live order');
} catch (e) {
  exit = 1;
  console.error(`SANDBOX CHECK FAIL: ${(e as Error).message}`);
}

if (recordDir) {
  const secrets = [
    env.TASTYTRADE_CERT_REFRESH_TOKEN,
    env.TASTYTRADE_CERT_CLIENT_SECRET,
    env.TASTYTRADE_CERT_CLIENT_ID,
    env.TASTYTRADE_CERT_ACCESS_TOKEN,
  ].filter((x): x is string => !!x);
  const acctIds = new Set<string>();
  for (const r of recorded) for (const m of r.url.matchAll(/\/accounts\/([^/?]+)/g)) acctIds.add(m[1]!);
  const scrub = (s: string | null) => {
    if (s == null) return s;
    let out = s;
    for (const x of secrets) out = out.split(x).join('SCRUBBED');
    for (const id of acctIds) out = out.split(id).join('5WA00000');
    return out
      .replace(/"access_token":\s*"[^"]*"/g, '"access_token":"SCRUBBED_ACCESS_TOKEN"')
      .replace(/"(token|id_token)":\s*"[^"]*"/g, '"$1":"SCRUBBED_TOKEN"')
      .replace(
        /"(first-name|last-name|first_name|last_name|nickname|account-name|external-id|email|username)":\s*"[^"]*"/g,
        '"$1":"demo"',
      );
  };
  const out = recorded.map((r) => ({
    method: r.method,
    url: scrub(r.url),
    body: scrub(r.body),
    status: r.status,
    response: scrub(r.response),
  }));
  fs.mkdirSync(recordDir, { recursive: true });
  const file = path.join(recordDir, 'tastytrade-sandbox.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`recorded ${out.length} exchanges → ${file}`);
}
process.exit(exit);
