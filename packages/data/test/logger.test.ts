/* eslint-disable @typescript-eslint/no-explicit-any -- assertions over dynamic JSON results */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fakeFetch, NOW, SYM, S0, R, type FakeOpts } from './fixtures/fake-market.ts';

const h = vi.hoisted(() => ({ impl: null as null | ((u: string, i?: any) => Promise<any>) }));
vi.mock('../src/yahoo/http.ts', () => ({ httpFetch: (u: string, i?: any) => h.impl!(u, i) }));

async function load(o: FakeOpts = {}) {
  h.impl = fakeFetch(o).fn;
  vi.resetModules();
  return import('../src/yahoo/logger.ts');
}

let dir = '';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPT_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = '2026-06-01';
const summaryLines = () =>
  fs
    .readFileSync(path.join(dir, SYM, 'summary.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('logChain', () => {
  it('writes a gzipped full-chain snapshot and a one-line ATM summary', async () => {
    const { logChain, loadSnapshot } = await load();
    const r: any = await logChain(SYM.toLowerCase(), { dir });
    expect(r.file).toBe(path.join(dir, SYM, `${DAY}.json.gz`));
    expect(r.expiries).toBe(2);
    expect(r.contracts).toBe(28);
    expect(r.bytes).toBe(fs.statSync(r.file).size);
    expect(JSON.parse(JSON.stringify(r.summary))).toEqual({
      // JSON round-trip: -0 skew is written as 0
      date: DAY,
      loggedAt: new Date(NOW).toISOString(),
      session: 'regular',
      S: S0,
      cm7: 0.55,
      cm30: 0.55,
      cm60: 0.55,
      cm90: 0.55,
      term: [
        { e: '2026-06-19', dte: 18.21, atm: 0.55, mv: 9.78, rr25: 0, bf25: 0, pcOi: 1, maxPain: 100, gex: 0 },
        { e: '2026-07-17', dte: 46.21, atm: 0.55, mv: 15.54, rr25: 0, bf25: 0, pcOi: 1, maxPain: 100, gex: 0 },
      ],
      nextEarnings: '2026-07-22',
      eventMoveStd: null,
      eventMoveAbs: null,
    });
    expect(summaryLines()).toEqual([JSON.parse(JSON.stringify(r.summary))]);

    const snap = loadSnapshot(SYM, DAY, dir);
    expect(snap).toEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(r.file)).toString()));
    expect(snap.symbol).toBe('test');
    expect(snap.tradingDay).toBe(DAY);
    expect(snap.S).toBe(S0);
    expect(snap.r).toBe(R);
    expect(snap.chains.map((c: any) => c.expiry)).toEqual(['2026-06-19', '2026-07-17']);
    const atmCall = snap.chains[0].contracts.find((c: any) => c.k === 100 && c.r === 'C');
    expect(atmCall).toMatchObject({ ms: 'mid', iv: 0.55, v: 100, oi: 1000 });
    expect(atmCall.m).toBeCloseTo(4.9907, 3);
  });

  it('skips a second run on the same trading day unless forced, and --force replaces only that day', async () => {
    const { logChain } = await load();
    fs.mkdirSync(path.join(dir, SYM), { recursive: true });
    fs.writeFileSync(path.join(dir, SYM, 'summary.jsonl'), JSON.stringify({ date: '2026-05-29', cm30: 0.4 }) + '\n');
    const first: any = await logChain(SYM, { dir });
    expect(await logChain(SYM, { dir })).toEqual({
      skipped: true,
      file: first.file,
      reason: 'already logged today (use --force to overwrite)',
    });
    const forced: any = await logChain(SYM, { dir, force: true });
    expect(forced.expiries).toBe(2);
    expect(summaryLines().map((l) => l.date)).toEqual(['2026-05-29', DAY]);
  });

  it('respects maxDte, defaults to OPT_LOG_DIR, and records a calendar failure instead of throwing', async () => {
    process.env.OPT_LOG_DIR = dir;
    const { logChain, loadSnapshot } = await load({ calendarFails: true });
    const r: any = await logChain(SYM, { maxDte: 30 });
    expect(r.file).toBe(path.join(dir, SYM, `${DAY}.json.gz`));
    expect(r.expiries).toBe(1);
    expect(r.contracts).toBe(14);
    expect(r.summary.nextEarnings).toBeNull();
    expect(r.summary.earningsError).toMatch(/500/);
    expect(loadSnapshot(SYM, DAY).chains.map((c: any) => c.expiry)).toEqual(['2026-06-19']);
  });
});
