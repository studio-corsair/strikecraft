// Volatility over time: realized-vol estimators, per-day IV backed out of a contract's daily
// closes (with the cleaning daily option closes need), IV rank / percentile, and
// earnings-reaction history (actual move vs implied move).
import { impliedVol } from './bs.ts';
import { median, mean, stdev, rnd } from './math.ts';
import { expiryMs, YEAR_MS } from './position.ts';

export interface Bar {
  date: string;
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  adjclose?: number;
  volume: number;
}

/** Annualized close-to-close realized vol over the last `n` returns. */
export function realizedVol(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const c = closes.slice(-(n + 1));
  const rets = c.slice(1).map((x, i) => Math.log(x / c[i]!));
  return stdev(rets) * Math.sqrt(252);
}

/** Parkinson high-low estimator (uses intraday range; ~5× more efficient than close-to-close). */
export function parkinsonVol(bars: Bar[], n: number): number | null {
  if (bars.length < n) return null;
  const b = bars.slice(-n);
  return Math.sqrt(b.reduce((s, x) => s + Math.log(x.high / x.low) ** 2, 0) / (4 * Math.log(2) * n)) * Math.sqrt(252);
}

/** Yang-Zhang estimator (handles overnight gaps + drift). */
export function yangZhangVol(bars: Bar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const b = bars.slice(-(n + 1));
  const o: number[] = [],
    c: number[] = [],
    rs: number[] = [];
  for (let i = 1; i < b.length; i++) {
    const x = b[i]!,
      prev = b[i - 1]!;
    o.push(Math.log(x.open / prev.close));
    c.push(Math.log(x.close / x.open));
    rs.push(
      Math.log(x.high / x.close) * Math.log(x.high / x.open) + Math.log(x.low / x.close) * Math.log(x.low / x.open),
    );
  }
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const v = stdev(o) ** 2 + k * stdev(c) ** 2 + (1 - k) * mean(rs);
  return Math.sqrt(v * 252);
}

/** Rolling close-to-close realized vol series. */
export function rollingRealized(bars: Bar[], n: number): { date: string; rv: number | null }[] {
  const closes = bars.map((b) => b.close);
  return bars.map((b, i) => ({ date: b.date, rv: i >= n ? realizedVol(closes.slice(0, i + 1), n) : null }));
}

/**
 * Per-day implied vol of one contract from its daily close vs the underlying's close.
 * Cleaning (daily option closes are stale and noisy):
 *  1. zero-volume days are dropped — the "close" is a carried-forward print, not a trade that day;
 *  2. prices outside no-arbitrage bounds (below intrinsic) are dropped — trade printed vs a different S;
 *  3. a Hampel filter (rolling median ± 3·1.4826·MAD, window 7) rejects isolated spikes.
 */
export function backoutIvSeries(
  optBars: Bar[],
  undBars: Bar[],
  spec: { strike: number; right: 'C' | 'P'; expiry: string; r: number; q: number; minVolume?: number },
) {
  const und = new Map(undBars.map((b) => [b.date, b.close]));
  const exp = expiryMs(spec.expiry);
  const rows: {
    date: string;
    S: number | null;
    optClose: number;
    volume: number;
    iv: number | null;
    flag: string | null;
    rawIv?: number | null;
  }[] = [];
  for (const b of optBars) {
    const S = und.get(b.date) ?? null;
    let iv: number | null = null,
      flag: string | null = null;
    if (S == null) flag = 'no underlying close';
    else if ((b.volume ?? 0) < (spec.minVolume ?? 1)) flag = 'no trades (stale close)';
    else {
      // option close ≈ 16:00 ET on that date
      const T = (exp - expiryMs(b.date)) / YEAR_MS;
      iv = T > 0 ? impliedVol(b.close, { S, K: spec.strike, T, r: spec.r, q: spec.q, right: spec.right }) : null;
      if (iv == null) flag = T > 0 ? 'outside no-arbitrage bounds' : 'expired';
    }
    rows.push({ date: b.date, S, optClose: b.close, volume: b.volume ?? 0, iv, flag });
  }
  // Hampel filter on the surviving IVs.
  const good = rows.filter((r) => r.iv != null);
  const W = 3;
  good.forEach((r, i) => {
    const win = good.slice(Math.max(0, i - W), i + W + 1).map((x) => x.iv!);
    if (win.length < 5) return;
    const med = median(win),
      mad = median(win.map((x) => Math.abs(x - med))) * 1.4826;
    if (mad > 0 && Math.abs(r.iv! - med) > 3 * mad) {
      r.flag = `spike rejected (median ${med.toFixed(3)})`;
      r.rawIv = r.iv;
      r.iv = null;
    }
  });
  return rows;
}

/**
 * IV rank (where today sits in the range) and IV percentile (share of days below today).
 * @param series historical values, oldest first; last = current
 */
export function ivRank(series: number[]) {
  const xs = series.filter((x) => Number.isFinite(x));
  if (xs.length < 2) return null;
  const cur = xs[xs.length - 1]!,
    lo = Math.min(...xs),
    hi = Math.max(...xs);
  return {
    current: rnd(cur, 4),
    low: rnd(lo, 4),
    high: rnd(hi, 4),
    observations: xs.length,
    ivRank: hi > lo ? rnd((cur - lo) / (hi - lo), 4) : null,
    ivPercentile: rnd(xs.slice(0, -1).filter((x) => x < cur).length / (xs.length - 1), 4),
  };
}

/**
 * Earnings reactions: the move from the last close before the news to the first close after.
 * AMC → close(D) to close(D+1); BMO / DURING → close(D−1) to close(D).
 * @param bars daily, oldest first
 */
export function earningsReactions(events: { date: string; timing: string }[], bars: Bar[]) {
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const out = [];
  for (const e of events) {
    // first bar on/after the event date
    let i = idx.get(e.date);
    if (i == null) {
      const j = bars.findIndex((b) => b.date > e.date);
      if (j < 0) continue;
      i = j;
    }
    const [a, b]: [number, number] = e.timing === 'AMC' ? [i, i + 1] : [i - 1, i];
    const before = bars[a],
      after = bars[b];
    if (!before || !after || a < 0) continue;
    const move = after.close / before.close - 1;
    const gap = after.open / before.close - 1;
    out.push({
      date: e.date,
      timing: e.timing,
      closeBefore: rnd(before.close, 2),
      closeAfter: rnd(after.close, 2),
      movePct: rnd(move * 100, 2),
      gapPct: rnd(gap * 100, 2),
    });
  }
  return out;
}

/** Summary stats of reaction moves (percent). */
export function reactionStats(rx: { movePct: number | null }[]) {
  const m = rx.map((x) => x.movePct as number).filter((x) => x != null);
  const a = m.map(Math.abs);
  if (!m.length) return null;
  return {
    quarters: m.length,
    meanAbsMovePct: rnd(mean(a), 2),
    medianAbsMovePct: rnd(median(a), 2),
    stdevMovePct: rnd(stdev(m), 2),
    maxAbsMovePct: rnd(Math.max(...a), 2),
    upCount: m.filter((x) => x > 0).length,
    downCount: m.filter((x) => x < 0).length,
    last4AbsPct: a.slice(-4).map((x) => rnd(x, 2)),
  };
}
