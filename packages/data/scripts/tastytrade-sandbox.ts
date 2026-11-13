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
import { tastytradeBroker, TASTYTRADE_HOSTS } from '../src/broker/tastytrade.ts';
import type { TastytradeAuth } from '../src/broker/tastytrade.ts';
import type { FetchLike, OrderRequest } from '../src/broker/types.ts';

const sym = (process.argv[2] ?? 'NVDA').toUpperCase();
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

const hostsSeen = new Set<string>();
const trackingFetch: FetchLike = async (url, init) => {
  hostsSeen.add(new URL(url).host);
  const res = await fetch(url, init);
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: async () => text };
};

const broker = tastytradeBroker({ auth, env: 'sandbox', fetch: trackingFetch });
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
  // Without a quote, the highest strikes are the furthest out of the money for a call vertical.
  const [short, long] = strikes.slice(-2).reverse();
  if (!long || !short) throw new Error('the chain has fewer than two strikes');
  const order: OrderRequest = {
    underlying: sym,
    type: 'debit',
    price: 0.01,
    duration: 'day',
    tag: 'strikebench-sandbox-check',
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
  console.log(`${'hosts contacted'.padEnd(16)} ${[...hostsSeen].join(', ')} (allowed: ${broker.hosts.join(', ')})`);
  if ([...hostsSeen].some((h) => h !== TASTYTRADE_HOSTS.sandbox)) throw new Error('a request left the sandbox host');
  console.log('SANDBOX CHECK PASS: dry-run + place + cancel of a multi-leg order, cert sandbox only, no live order');
} catch (e) {
  exit = 1;
  console.error(`SANDBOX CHECK FAIL: ${(e as Error).message}`);
}
process.exit(exit);
