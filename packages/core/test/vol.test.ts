import { describe, expect, it } from 'vitest';
import {
  realizedVol,
  parkinsonVol,
  backoutIvSeries,
  ivRank,
  earningsReactions,
  reactionStats,
  yangZhangVol,
} from '../src/vol.ts';
import { bsPrice } from '../src/bs.ts';
import { expiryMs } from '../src/position.ts';

function gbm(n: number, sigma: number, seed = 3) {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const bars = [];
  let px = 100;
  const d0 = Date.parse('2026-01-02T00:00:00Z');
  for (let i = 0; i < n; i++) {
    // intraday path; the close is where the path ends
    const open = px;
    let hi = open,
      lo = open,
      x = open;
    for (let k = 0; k < 200; k++) {
      x *= Math.exp((sigma / Math.sqrt(252 * 200)) * g());
      hi = Math.max(hi, x);
      lo = Math.min(lo, x);
    }
    const close = x;
    bars.push({
      date: new Date(d0 + i * 864e5).toISOString().slice(0, 10),
      t: 0,
      open,
      high: hi,
      low: lo,
      close,
      volume: 100,
    });
    px = close;
  }
  return bars;
}

describe('realized vol estimators', () => {
  const bars = gbm(2000, 0.4);
  it('close-to-close recovers the generating vol', () => {
    expect(
      realizedVol(
        bars.map((b) => b.close),
        1999,
      )!,
    ).toBeCloseTo(0.4, 1);
  });
  it('Parkinson and Yang-Zhang land near the generating vol', () => {
    expect(Math.abs(parkinsonVol(bars, 1999)! - 0.4)).toBeLessThan(0.06); // discrete path biases range low
    expect(Math.abs(yangZhangVol(bars, 1999)! - 0.4)).toBeLessThan(0.06);
  });
});

describe('IV backout from daily closes', () => {
  const spec = { strike: 185, right: 'C' as const, expiry: '2026-12-18', r: 0.04, q: 0 };
  const dates = [
    '2026-10-01',
    '2026-10-02',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-12',
    '2026-10-13',
  ];
  const und = dates.map((d, i) => ({ date: d, t: 0, open: 0, high: 0, low: 0, close: 170 + i, volume: 1 }));
  const T = (d: string) => (expiryMs('2026-12-18') - expiryMs(d)) / (365 * 864e5);
  const opt = dates.map((d, i) => ({
    date: d,
    t: 0,
    open: 0,
    high: 0,
    low: 0,
    close: bsPrice({ S: 170 + i, K: 185, T: T(d), r: 0.04, q: 0, sigma: 0.5, right: 'C' }),
    volume: 50,
  }));
  it('recovers a constant 50% vol', () => {
    const rows = backoutIvSeries(opt, und, spec);
    for (const r of rows) expect(r.iv!).toBeCloseTo(0.5, 5);
  });
  it('drops zero-volume (stale) closes, sub-intrinsic prints and spikes', () => {
    const o = opt.map((x) => ({ ...x }));
    o[2]!.volume = 0;
    o[3]!.close = 0.01; // absurd print → IV far below the rest → spike/abnormal
    o[5]!.close = o[5]!.close * 3; // spike
    const rows = backoutIvSeries(o, und, spec);
    expect(rows[2]!.flag).toMatch(/stale/);
    expect(rows[3]!.iv).toBeNull();
    expect(rows[5]!.iv).toBeNull();
    expect(rows[5]!.flag).toMatch(/spike/);
  });
});

describe('IV rank / percentile', () => {
  it('computes rank and percentile', () => {
    const r = ivRank([0.3, 0.4, 0.5, 0.6, 0.45])!;
    expect(r.ivRank).toBeCloseTo((0.45 - 0.3) / 0.3, 4);
    expect(r.ivPercentile).toBeCloseTo(0.5, 4);
  });
});

describe('earnings reactions', () => {
  const bars = [
    { date: '2026-08-25', close: 100, open: 100 },
    { date: '2026-08-26', close: 102, open: 101 },
    { date: '2026-08-27', close: 95, open: 96 },
    { date: '2026-08-28', close: 96, open: 95 },
  ].map((b) => ({ ...b, t: 0, high: 0, low: 0, volume: 1 }));
  it('AMC uses close(D) → close(D+1)', () => {
    const [x] = earningsReactions([{ date: '2026-08-26', timing: 'AMC' }], bars);
    expect(x!.movePct).toBeCloseTo((95 / 102 - 1) * 100, 2);
    expect(x!.gapPct).toBeCloseTo((96 / 102 - 1) * 100, 2);
  });
  it('BMO uses close(D−1) → close(D)', () => {
    const [x] = earningsReactions([{ date: '2026-08-26', timing: 'BMO' }], bars);
    expect(x!.movePct).toBeCloseTo(2, 2);
  });
  it('stats', () => {
    const s = reactionStats([{ movePct: 5 }, { movePct: -10 }, { movePct: 3 }])!;
    expect(s.meanAbsMovePct).toBe(6);
    expect(s.upCount).toBe(2);
  });
});
