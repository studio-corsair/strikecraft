// Option-chain analytics: our own IVs (Yahoo's impliedVolatility field is unreliable), greeks,
// ATM IV / term structure, 25-delta skew (risk reversal, butterfly), expected move from the ATM
// straddle and from IV, put/call ratios, max pain, dealer gamma exposure (GEX), and the
// earnings event-variance decomposition (implied event move + post-event "crushed" IV).
import { impliedVol, bsGreeks } from './bs.ts';
import { rnd } from './math.ts';
import { expiryMs, YEAR_MS } from './position.ts';

export interface Contract {
  strike: number;
  right: 'C' | 'P';
  bid: number;
  ask: number;
  last: number;
  volume: number;
  oi: number;
  mid: number | null;
  mark: number | null;
  markSource: string;
  iv: number | null;
  yahooIv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  contract: string;
  lastTradeDate: number | null;
}
export interface Expiry {
  expiry: string;
  T: number;
  S: number;
  r: number;
  q: number;
  contracts: Contract[];
}

/** The fields of a raw Yahoo option row that buildExpiry reads. */
export interface RawOptionRow {
  strike: number;
  bid?: number | null;
  ask?: number | null;
  lastPrice?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  impliedVolatility?: number | null;
  contractSymbol: string;
  lastTradeDate?: number | null;
}

/**
 * Normalize raw Yahoo rows and compute IV + greeks. Mark = mid when the quote is two-sided
 * and sane, else last trade (flagged); IV solved against `S` (pass the price the marks are
 * consistent with — the regular close outside market hours).
 * A last-trade mark older than `staleMinutes` before `markTime` (the time S refers to) is not
 * comparable to S, so it gets no IV (it would be priced against a different underlying).
 */
export function buildExpiry(
  calls: RawOptionRow[],
  puts: RawOptionRow[],
  ctx: { expiry: string; S: number; r: number; q: number; now: number; markTime?: number; staleMinutes?: number },
): Expiry {
  const T = Math.max((expiryMs(ctx.expiry) - ctx.now) / YEAR_MS, 0.5 / 365);
  const contracts: Contract[] = [];
  for (const [rows, right] of [
    [calls, 'C'],
    [puts, 'P'],
  ] as [RawOptionRow[], 'C' | 'P'][]) {
    for (const c of rows) {
      const bid = c.bid ?? 0,
        ask = c.ask ?? 0,
        last = c.lastPrice ?? 0;
      const twoSided = bid > 0 && ask > 0 && ask >= bid && (ask - bid) / ((ask + bid) / 2) < 0.5;
      const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
      const ageMin =
        !twoSided && last > 0 && ctx.markTime && c.lastTradeDate ? (ctx.markTime - c.lastTradeDate) / 60 : 0;
      const stale = ageMin > (ctx.staleMinutes ?? 60);
      const mark = twoSided ? mid : last > 0 ? last : null;
      const markSource = twoSided
        ? 'mid'
        : last > 0
          ? stale
            ? `last (stale ${Math.round(ageMin)} min before S)`
            : 'last (no usable quote)'
          : 'none';
      const p = { S: ctx.S, K: c.strike, T, r: ctx.r, q: ctx.q, right };
      const iv = mark != null && !stale ? impliedVol(mark, p) : null;
      const g = iv ? bsGreeks({ ...p, sigma: iv }) : null;
      contracts.push({
        strike: c.strike,
        right,
        bid,
        ask,
        last,
        volume: c.volume ?? 0,
        oi: c.openInterest ?? 0,
        mid,
        mark,
        markSource,
        iv,
        yahooIv: c.impliedVolatility ?? null,
        delta: g?.delta ?? null,
        gamma: g?.gamma ?? null,
        theta: g?.theta ?? null,
        vega: g?.vega ?? null,
        contract: c.contractSymbol,
        lastTradeDate: c.lastTradeDate ?? null,
      });
    }
  }
  return { expiry: ctx.expiry, T, S: ctx.S, r: ctx.r, q: ctx.q, contracts };
}

const side = (cs: Contract[], right: 'C' | 'P') =>
  cs.filter((c) => c.right === right && c.iv != null).sort((a, b) => a.strike - b.strike);

/**
 * Linear interpolation of y at x over points sorted by x.
 */
function interp(pts: { x: number; y: number }[], x: number): number | null {
  if (!pts.length) return null;
  const f = pts[0]!,
    l = pts[pts.length - 1]!;
  if (x <= f.x) return f.y;
  if (x >= l.x) return l.y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!,
      b = pts[i]!;
    if (x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return null;
}

/**
 * ATM IV at the forward: OTM-side IVs (puts below F, calls above), interpolated at F.
 */
export function atmIv(e: Expiry): { forward: number; iv: number | null } {
  const F = e.S * Math.exp((e.r - e.q) * e.T);
  const pts = [
    ...side(e.contracts, 'P').filter((c) => c.strike <= F),
    ...side(e.contracts, 'C').filter((c) => c.strike > F),
  ]
    .map((c) => ({ x: c.strike, y: c.iv! }))
    .sort((a, b) => a.x - b.x);
  // only the strikes adjacent to F matter; restrict to avoid wing noise
  const near = pts.filter((p) => Math.abs(p.x / F - 1) < 0.15);
  return { forward: F, iv: interp(near.length >= 2 ? near : pts, F) };
}

/**
 * IV at a target delta (|delta| for puts), interpolating IV against delta.
 * @param target e.g. 0.25
 */
export function ivAtDelta(e: Expiry, right: 'C' | 'P', target: number): number | null {
  const pts = side(e.contracts, right)
    .filter((c) => c.delta != null && Math.abs(c.delta) > 0.02 && Math.abs(c.delta) < 0.98)
    .map((c) => ({ x: Math.abs(c.delta!), y: c.iv!, k: c.strike }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return null;
  return interp(pts, target);
}

/**
 * Straddle at the strike nearest the forward → expected move.
 * straddle ≈ E|S_T − K| = 0.798σ√T·S for a normal, so the implied 1σ move is straddle·√(π/2).
 */
export function straddle(e: Expiry) {
  const F = e.S * Math.exp((e.r - e.q) * e.T);
  const usable = (x: Contract | undefined) => x?.mark != null && x.iv != null;
  const strikes = [...new Set(e.contracts.map((c) => c.strike))].filter(
    (k) =>
      usable(e.contracts.find((x) => x.right === 'C' && x.strike === k)) &&
      usable(e.contracts.find((x) => x.right === 'P' && x.strike === k)),
  );
  if (!strikes.length) return null;
  const K = strikes.reduce((b, k) => (Math.abs(k - F) < Math.abs(b - F) ? k : b));
  const c = e.contracts.find((x) => x.right === 'C' && x.strike === K)!,
    p = e.contracts.find((x) => x.right === 'P' && x.strike === K)!;
  if (!c.mark || !p.mark) return null;
  const px = c.mark + p.mark;
  return {
    strike: K,
    price: px,
    expectedMoveAbs: px,
    expectedMovePct: px / e.S,
    implied1SigmaPct: (px * Math.sqrt(Math.PI / 2)) / e.S,
    quality: c.markSource === 'mid' && p.markSource === 'mid' ? 'mid' : 'last-trade (stale outside hours)',
  };
}

/**
 * Yahoo zeroes open interest outside regular hours (and sometimes leaves a few stale values),
 * so OI-based stats are only computed when most contracts carry OI.
 */
export const oiReliable = (e: Expiry): boolean =>
  e.contracts.length > 0 && e.contracts.filter((c) => c.oi > 0).length / e.contracts.length >= 0.5;

/** Max pain: the settlement price that minimizes total intrinsic paid to option holders. */
export function maxPain(e: Expiry): number | null {
  if (!oiReliable(e)) return null;
  const strikes = [...new Set(e.contracts.map((c) => c.strike))].sort((a, b) => a - b);
  let best = null,
    bestPay = Infinity;
  for (const s of strikes) {
    let pay = 0;
    for (const c of e.contracts) pay += c.oi * Math.max(c.right === 'C' ? s - c.strike : c.strike - s, 0);
    if (pay < bestPay) {
      bestPay = pay;
      best = s;
    }
  }
  return best;
}

/**
 * Dealer gamma exposure in $ per 1% move, assuming dealers are long calls / short puts to the
 * public the conventional (SqueezeMetrics-style) way: calls +, puts −. Sign is a convention, not a fact.
 */
export function gex(e: Expiry): number | null {
  if (!oiReliable(e)) return null;
  let g = 0;
  for (const c of e.contracts)
    if (c.gamma != null) g += (c.right === 'C' ? 1 : -1) * c.gamma * c.oi * 100 * e.S * e.S * 0.01;
  return g;
}

/** Summary row for one expiry. */
export function expirySummary(e: Expiry) {
  const a = atmIv(e),
    st = straddle(e);
  const c25 = ivAtDelta(e, 'C', 0.25),
    p25 = ivAtDelta(e, 'P', 0.25),
    c10 = ivAtDelta(e, 'C', 0.1),
    p10 = ivAtDelta(e, 'P', 0.1);
  const sum = (r: 'C' | 'P', k: 'oi' | 'volume') =>
    e.contracts.filter((c) => c.right === r).reduce((s, c) => s + c[k], 0);
  return {
    expiry: e.expiry,
    dte: rnd(e.T * 365, 2),
    forward: rnd(a.forward, 2),
    atmIv: rnd(a.iv, 4),
    expectedMoveFromIv: a.iv ? rnd(e.S * a.iv * Math.sqrt(e.T), 2) : null,
    straddle: st
      ? {
          strike: st.strike,
          price: rnd(st.price, 2),
          movePct: rnd(st.expectedMovePct * 100, 2),
          implied1SigmaPct: rnd(st.implied1SigmaPct * 100, 2),
          quality: st.quality,
        }
      : null,
    skew: {
      iv25Call: rnd(c25, 4),
      iv25Put: rnd(p25, 4),
      riskReversal25: c25 != null && p25 != null ? rnd(c25 - p25, 4) : null,
      butterfly25: c25 != null && p25 != null && a.iv ? rnd((c25 + p25) / 2 - a.iv, 4) : null,
      iv10Call: rnd(c10, 4),
      iv10Put: rnd(p10, 4),
    },
    putCallOi: oiReliable(e) && sum('C', 'oi') ? rnd(sum('P', 'oi') / sum('C', 'oi'), 3) : null,
    putCallVolume: sum('C', 'volume') ? rnd(sum('P', 'volume') / sum('C', 'volume'), 3) : null,
    maxPain: maxPain(e),
    gexPer1PctUsd: (() => {
      const g = gex(e);
      return g == null ? null : Math.round(g);
    })(),
    contractsWithIv: e.contracts.filter((c) => c.iv != null).length,
    contractsOnLastTrade: e.contracts.filter((c) => c.markSource.startsWith('last')).length,
    contractsStale: e.contracts.filter((c) => c.markSource.includes('stale')).length,
    openInterestAvailable: oiReliable(e),
  };
}

/**
 * Constant-maturity ATM IV (e.g. 30-day) by interpolating total variance σ²T between expiries.
 */
export function constantMaturityIv(term: { T: number; iv: number | null }[], days: number): number | null {
  const pts = term
    .filter((x) => x.iv != null)
    .map((x) => ({ x: x.T, y: x.iv! ** 2 * x.T }))
    .sort((a, b) => a.x - b.x);
  const T = days / 365,
    w = interp(pts, T);
  if (w == null || pts.length < 2) return null;
  // flat-extrapolate vol (not variance) outside the range
  const f = pts[0]!,
    l = pts[pts.length - 1]!;
  if (T < f.x) return Math.sqrt(f.y / f.x);
  if (T > l.x) return Math.sqrt(l.y / l.x);
  return Math.sqrt(w / T);
}

/**
 * Earnings event-variance decomposition. Total variance of an expiry spanning the event is
 * σ²T = σx²T + E² (σx = ex-event vol, E = event move std as a fraction). From two post-event
 * expiries (T1 < T2): σx² = (σ2²T2 − σ1²T1)/(T2 − T1), E² = σ1²T1 − σx²T1. If a pre-event expiry
 * exists its IV is used as σx directly (more robust). Post-event IV of any expiry ≈ sqrt(σ²−E²/T).
 * @param eventDate YYYY-MM-DD (announcement day)
 */
export function eventVariance(
  term: { expiry: string; T: number; iv: number | null }[],
  eventDate: string,
  timing: 'AMC' | 'BMO' | 'DURING' = 'AMC',
) {
  // The move lands on the first session after an AMC release, or the release day for BMO.
  const eventEndMs = expiryMs(eventDate) + (timing === 'AMC' ? 864e5 : 0);
  const pts = term.filter((x) => x.iv != null);
  const pre = pts.filter((x) => expiryMs(x.expiry) < eventEndMs).sort((a, b) => b.T - a.T)[0];
  const post = pts.filter((x) => expiryMs(x.expiry) >= eventEndMs).sort((a, b) => a.T - b.T);
  const p1 = post[0],
    p2 = post[1];
  if (!p1) return null;
  let sx2: number | null = null;
  let method = '';
  const iv1 = p1.iv ?? 0;
  if (pre && pre.T > 1.5 / 365) {
    sx2 = (pre.iv ?? 0) ** 2;
    method = `ex-event vol = IV of pre-event expiry ${pre.expiry}`;
  } else if (p2) {
    const iv2 = p2.iv ?? 0;
    sx2 = (iv2 ** 2 * p2.T - iv1 ** 2 * p1.T) / (p2.T - p1.T);
    method = `term-structure solve ${p1.expiry} vs ${p2.expiry}`;
  }
  if (sx2 == null || sx2 <= 0) return { method: method || 'insufficient expiries', eventMoveStd: null };
  const E2 = p1.iv! ** 2 * p1.T - sx2 * p1.T;
  if (E2 <= 0)
    return {
      method,
      eventMoveStd: null,
      note: 'front post-event IV does not exceed ex-event vol — no event premium priced',
    };
  const E = Math.sqrt(E2);
  return {
    method,
    frontPostEventExpiry: p1.expiry,
    exEventVol: rnd(Math.sqrt(sx2), 4),
    eventMoveStd: rnd(E, 4), // 1σ event move as a fraction
    eventMoveExpectedAbs: rnd(E * Math.sqrt(2 / Math.PI), 4), // E|move| for a normal
    // Per-expiry ex-event vol: strip the event variance out of each expiry's total variance.
    postEventIv: Object.fromEntries(
      post.map((x) => {
        const v = x.iv! ** 2 * x.T - E2;
        return [x.expiry, v > 0 ? rnd(Math.sqrt(v / x.T), 4) : null];
      }),
    ),
  };
}
