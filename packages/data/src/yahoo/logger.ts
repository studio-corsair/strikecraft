// Daily option-chain logger: Yahoo keeps no option history, so we record it ourselves.
// Each run writes <dir>/<SYM>/<YYYY-MM-DD>.json.gz (full chain, every expiry ≤ maxDte, our IVs)
// and appends one line to <dir>/<SYM>/summary.jsonl (ATM term structure, constant-maturity IVs,
// expected moves, skew, next-earnings implied move) — the series IV rank and the
// implied-vs-actual earnings history are computed from.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { marketState, expiryChain, expirations, defaultLogDir } from './live.ts';
import { expirySummary, constantMaturityIv, eventVariance, expiryMs, rnd } from '@strikebench/core';
import * as data from './data.ts';
import type { Json } from './http.ts';

export async function logChain(sym: string, o: { dir?: string; maxDte?: number; force?: boolean } = {}) {
  const dir = path.join(o.dir ?? defaultLogDir(), sym.toUpperCase());
  fs.mkdirSync(dir, { recursive: true });
  const ms = await marketState(sym);
  // Trading date in New York of the session the marks belong to (pre-market runs log the prior session).
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date((ms.markTime ?? ms.now / 1000) * 1000),
  );
  const file = path.join(dir, `${day}.json.gz`);
  if (fs.existsSync(file) && !o.force)
    return { skipped: true, file, reason: 'already logged today (use --force to overwrite)' };
  const exps = (await expirations(sym)).filter(
    (d) => expiryMs(d) > ms.now && (expiryMs(d) - ms.now) / 864e5 <= (o.maxDte ?? 400),
  );
  const chains = [];
  const term = [];
  for (const d of exps) {
    const e = await expiryChain(ms, d);
    chains.push({
      expiry: d,
      T: e.T,
      contracts: e.contracts.map((c) => ({
        k: c.strike,
        r: c.right,
        b: c.bid,
        a: c.ask,
        l: c.last,
        v: c.volume,
        oi: c.oi,
        m: c.mark,
        ms: c.markSource === 'mid' ? 'mid' : 'last',
        iv: rnd(c.iv, 5),
        yiv: rnd(c.yahooIv, 5),
        d: rnd(c.delta, 5),
      })),
    });
    term.push(expirySummary(e));
  }
  const tsT = term.map((t) => ({ expiry: t.expiry, T: (t.dte as number) / 365, iv: t.atmIv }));
  const cal: Json = await data.summary(sym, 'calendarEvents').catch((e: Error) => ({ error: e.message })); // error-ok: recorded in summary.earningsError
  const next: number | undefined = cal.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
  const nextDate = next ? data.iso(next) : null;
  const ev = nextDate ? eventVariance(tsT, nextDate, 'AMC') : null;
  const snapshot = {
    symbol: sym,
    loggedAt: new Date(ms.now).toISOString(),
    tradingDay: day,
    session: ms.session,
    S: ms.S,
    Smarks: ms.Smarks,
    r: ms.r,
    q: ms.q,
    chains,
  };
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(snapshot)));
  const summary = {
    date: day,
    loggedAt: snapshot.loggedAt,
    session: ms.session,
    S: ms.Smarks,
    cm7: rnd(constantMaturityIv(tsT, 7), 5),
    cm30: rnd(constantMaturityIv(tsT, 30), 5),
    cm60: rnd(constantMaturityIv(tsT, 60), 5),
    cm90: rnd(constantMaturityIv(tsT, 90), 5),
    term: term.map((t) => ({
      e: t.expiry,
      dte: t.dte,
      atm: t.atmIv,
      mv: t.straddle?.movePct ?? null,
      rr25: t.skew.riskReversal25,
      bf25: t.skew.butterfly25,
      pcOi: t.putCallOi,
      maxPain: t.maxPain,
      gex: t.gexPer1PctUsd,
    })),
    nextEarnings: nextDate,
    eventMoveStd: ev?.eventMoveStd ?? null,
    eventMoveAbs: ev?.eventMoveExpectedAbs ?? null,
    ...(cal.error ? { earningsError: cal.error as string } : {}),
  };
  // replace today's line if re-run with --force
  const sf = path.join(dir, 'summary.jsonl');
  const prior = fs.existsSync(sf)
    ? fs
        .readFileSync(sf, 'utf8')
        .split('\n')
        .filter((l) => l && !l.startsWith(`{"date":"${day}"`))
    : [];
  fs.writeFileSync(sf, [...prior, JSON.stringify(summary)].join('\n') + '\n');
  return {
    file,
    bytes: fs.statSync(file).size,
    expiries: chains.length,
    contracts: chains.reduce((s, c) => s + c.contracts.length, 0),
    summary,
  };
}

/** Load one logged snapshot. */
export function loadSnapshot(sym: string, day: string, dir = defaultLogDir()) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, sym.toUpperCase(), `${day}.json.gz`))).toString());
}
