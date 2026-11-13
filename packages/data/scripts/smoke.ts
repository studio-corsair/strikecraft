#!/usr/bin/env node
// Live smoke test of the market-data ladder: one real request per rung, printing the source tag
// of every answer. Usage: node packages/data/scripts/smoke.ts [SYMBOL]   (exit 1 if a rung fails)
import { createEngine, createLadder, cboeSource, yahooSource, httpFetch } from '../src/node.ts';

const sym = (process.argv[2] ?? 'NVDA').toUpperCase();
const fetchJson = async (url: string) => {
  const res = await httpFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};
const show = (
  name: string,
  t: { source: string; delayed: boolean; delayMinutes: number; asOf: number },
  extra: string,
) =>
  console.log(
    `${name.padEnd(22)} source=${t.source} delayed=${t.delayed} delayMinutes=${t.delayMinutes} asOf=${new Date(t.asOf).toISOString()} ${extra}`,
  );

let failed = false;
for (const src of [yahooSource(), cboeSource(fetchJson)]) {
  try {
    const q = await src.quote!(sym);
    show(`${src.label} quote`, q, `${sym} last=${q.lastPrice} session=${q.session}`);
    const e = await src.expirations!(sym);
    show(`${src.label} expirations`, e, `${e.expirations.length} expiries, first ${e.expirations[0]}`);
    const c = await src.optionChain!(sym, e.expirations[Math.min(3, e.expirations.length - 1)]!);
    show(`${src.label} chain`, c, `${c.expiry}: ${c.calls.length} calls, ${c.puts.length} puts`);
  } catch (err) {
    failed = true;
    console.error(`${src.label} FAILED: ${(err as Error).message}`);
  }
}

const ladder = createLadder([yahooSource(), cboeSource(fetchJson)]);
const engine = createEngine(ladder);
const ms = await engine.marketState(sym);
show('ladder marketState', ms.quoteSource, `S=${ms.S} r=${ms.r.toFixed(4)} (${ms.rSource})`);
console.log(
  'ladder status:',
  ladder
    .status()
    .map((r) => `${r.rank}.${r.label}=${r.state}`)
    .join(' '),
);
process.exit(failed ? 1 : 0);
