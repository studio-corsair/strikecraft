// Multi-leg positions: parsing, valuation at any date / price / IV shift, aggregate greeks,
// the thinkorswim "Analyze" risk-profile grid, and probability analysis (POP, EV, touch,
// breakevens, max profit/loss) under a lognormal distribution.
import { priceAndGreeks, intrinsic } from './bs.ts';
import { normCdf, normPdf, normInv, rnd, bisect } from './math.ts';

export const YEAR_MS = 365 * 864e5;

/**
 * qty: signed contracts (options) or signed shares (stock). entry: price paid per share (positive number).
 */
export interface Leg {
  qty: number;
  type: 'C' | 'P' | 'S';
  strike?: number;
  expiry?: string;
  entry: number;
  iv?: number | null;
  mult: number;
}
export interface Market {
  S: number;
  r: number;
  q: number;
  now: number;
  model?: 'bs' | 'american';
}

/** Expiry instant: 16:00 America/New_York on the expiry date (handles DST). @param d YYYY-MM-DD */
const NY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
const expiryCache = new Map<string, number>();

export function expiryMs(d: string): number {
  // Called for every leg at every price point of every curve, so the answer is cached per date:
  // building a date formatter each time made one analysis take over a second.
  const hit = expiryCache.get(d);
  if (hit !== undefined) return hit;
  // 16:00 ET = 20:00 UTC (EDT) or 21:00 UTC (EST). Probe the offset on that date.
  const noonUtc = new Date(`${d}T12:00:00Z`);
  const etHour = +NY_HOUR.format(noonUtc);
  const offset = 12 - etHour; // 4 (EDT) or 5 (EST)
  const ms = Date.parse(`${d}T${String(16 + offset).padStart(2, '0')}:00:00Z`);
  if (expiryCache.size > 5000) expiryCache.clear();
  expiryCache.set(d, ms);
  return ms;
}

/** Years from `atMs` to the leg's expiry. */
export const yearsTo = (leg: Leg, atMs: number): number =>
  leg.expiry ? Math.max((expiryMs(leg.expiry) - atMs) / YEAR_MS, 0) : 0;

// Parse a leg spec: "+1 C 185 2026-12-18 @4.71 iv=0.45", "-2 P 170 2026-11-20 @3.10",
// "+100 S @180" (stock, qty in shares). Option qty is in contracts (×100 multiplier).
export function parseLeg(spec: string): Leg {
  const t = spec.trim().split(/\s+/);
  const qty = Number(t[0]);
  const type = (t[1] ?? '').toUpperCase()[0] as 'C' | 'P' | 'S';
  if (!Number.isFinite(qty) || qty === 0 || !['C', 'P', 'S'].includes(type))
    throw new Error(`bad leg "${spec}" — want "+1 C 185 2026-12-18 @4.71 [iv=0.45]" or "+100 S @180"`);
  const at = t.find((x) => x.startsWith('@'));
  const ivTok = t.find((x) => /^iv=/i.test(x));
  const entry = at ? Number(at.slice(1)) : NaN;
  if (type === 'S') return { qty, type, entry, mult: 1 };
  const strike = Number(t[2]),
    expiry = t[3];
  if (!Number.isFinite(strike) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry ?? ''))
    throw new Error(`bad option leg "${spec}"`);
  return { qty, type, strike, expiry, entry, iv: ivTok ? Number(ivTok.slice(3)) : null, mult: 100 };
}

/**
 * Value and greeks of one leg (per position, i.e. × qty × multiplier).
 */
export function legValue(leg: Leg, m: Market, o: { S?: number; at?: number; ivShift?: number } = {}) {
  const S = o.S ?? m.S,
    at = o.at ?? m.now,
    k = leg.qty * leg.mult;
  if (leg.type === 'S')
    return { value: k * S, delta: k, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0, price: S };
  const T = yearsTo(leg, at);
  if (leg.iv == null)
    throw new Error(
      `leg ${leg.type} ${leg.strike} ${leg.expiry} has no IV (pass iv= or let the CLI back it out of the chain)`,
    );
  const sigma = Math.max(leg.iv + (o.ivShift ?? 0), 0.005);
  const g = T > 0 ? priceAndGreeks({ S, K: leg.strike!, T, r: m.r, q: m.q, sigma, right: leg.type }, m.model) : null;
  const price = g ? g.price : intrinsic(S, leg.strike!, leg.type);
  return {
    price,
    value: k * price,
    delta: k * (g ? g.delta : 0),
    gamma: k * (g ? g.gamma : 0),
    theta: k * (g ? g.theta : 0),
    vega: k * (g ? g.vega : 0),
    rho: k * (g ? g.rho : 0),
    vanna: k * (g ? g.vanna : 0),
    charm: k * (g ? g.charm : 0),
    vomma: k * (g ? g.vomma : 0),
  };
}

/** Net cost (debit > 0, credit < 0). */
export const cost = (legs: Leg[]): number => legs.reduce((s, l) => s + l.qty * l.mult * l.entry, 0);

/**
 * Position value, P&L and aggregate greeks.
 */
export function positionValue(legs: Leg[], m: Market, o: { S?: number; at?: number; ivShift?: number } = {}) {
  const agg = { value: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0 };
  for (const l of legs) {
    const v = legValue(l, m, o);
    for (const k of Object.keys(agg) as (keyof typeof agg)[]) agg[k] += v[k];
  }
  return { ...agg, pnl: agg.value - cost(legs) };
}

/** Earliest option expiry among legs (the analysis horizon). */
export function firstExpiry(legs: Leg[]): string | null {
  const e = legs
    .filter((l) => l.expiry)
    .map((l) => l.expiry!)
    .sort();
  return e[0] ?? null;
}

/** IV-weighted representative vol (by |vega|) for the distribution when none is given. */
export function representativeVol(legs: Leg[], m: Market): number | null {
  let w = 0,
    s = 0;
  for (const l of legs) {
    if (l.type === 'S' || l.iv == null) continue;
    const v = Math.abs(legValue(l, m).vega) || 1e-9;
    w += v;
    s += v * l.iv;
  }
  return w ? s / w : null;
}

/**
 * Risk profile grid: P&L by underlying price × evaluation date × IV shift.
 */
export function riskGrid(
  legs: Leg[],
  m: Market,
  o: { prices?: number[]; dates?: string[]; ivShifts?: number[]; steps?: number; sigma?: number } = {},
) {
  const fe = firstExpiry(legs);
  const horizon = fe ? expiryMs(fe) : m.now + 30 * 864e5;
  const sigma = o.sigma ?? representativeVol(legs, m) ?? 0.4;
  const tH = Math.max((horizon - m.now) / YEAR_MS, 1 / 365);
  let prices = o.prices;
  if (!prices) {
    const steps = o.steps ?? 21,
      span = 2.5 * sigma * Math.sqrt(tH);
    prices = Array.from({ length: steps }, (_, i) => m.S * Math.exp(-span + (2 * span * i) / (steps - 1)));
  }
  let dates: { label: string; at: number }[];
  if (o.dates)
    dates = o.dates.map((d) => ({
      label: d,
      at: d === 'now' ? m.now : d === 'expiry' ? horizon : Math.min(expiryMs(d) - 1, horizon),
    }));
  else
    dates = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const at = m.now + f * (horizon - m.now);
      return { label: f === 0 ? 'now (T+0)' : f === 1 ? `expiry ${fe}` : new Date(at).toISOString().slice(0, 10), at };
    });
  const ivShifts = o.ivShifts ?? [0];
  const rows = [];
  for (const iv of ivShifts)
    for (const d of dates) {
      rows.push({
        date: d.label,
        ivShift: iv,
        pnl: prices.map((S) => rnd(positionValue(legs, m, { S, at: d.at, ivShift: iv }).pnl, 2)),
      });
    }
  return {
    underlying: m.S,
    prices: prices.map((p) => rnd(p, 2)),
    movesPct: prices.map((p) => rnd((p / m.S - 1) * 100, 2)),
    rows,
  };
}

/**
 * Probability of touching a barrier B before T under GBM with risk-neutral drift.
 * Closed form via the reflection principle (running max / min of Brownian motion with drift).
 */
export function probTouch(S: number, B: number, T: number, sigma: number, r = 0, q = 0): number {
  if (T <= 0) return (B >= S ? S >= B : S <= B) ? 1 : 0;
  if (B === S) return 1;
  const nu = r - q - (sigma * sigma) / 2,
    b = Math.log(B / S),
    sq = sigma * Math.sqrt(T);
  const k = Math.exp((2 * nu * b) / (sigma * sigma));
  return B > S
    ? normCdf((-b + nu * T) / sq) + k * normCdf((-b - nu * T) / sq)
    : normCdf((b - nu * T) / sq) + k * normCdf((b + nu * T) / sq);
}

/** P(S_T > K) under the lognormal. */
export function probAbove(S: number, K: number, T: number, sigma: number, r = 0, q = 0): number {
  if (T <= 0) return S > K ? 1 : 0;
  return normCdf((Math.log(S / K) + (r - q - (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T)));
}

/**
 * Probability analysis at the horizon (first expiry by default): POP, expected value,
 * breakevens, max profit / max loss (with unbounded detection), per-strike ITM and touch odds.
 */
export function probability(
  legs: Leg[],
  m: Market,
  o: { sigma?: number; at?: string; drift?: 'riskneutral' | 'zero' } = {},
) {
  const fe = firstExpiry(legs);
  const horizon = o.at ? expiryMs(o.at) : fe ? expiryMs(fe) : m.now + 30 * 864e5;
  const t = Math.max((horizon - m.now) / YEAR_MS, 1e-6);
  const sigma = o.sigma ?? representativeVol(legs, m) ?? 0.4;
  const mu = o.drift === 'zero' ? 0 : m.r - m.q;
  const sq = sigma * Math.sqrt(t),
    drift = (mu - (sigma * sigma) / 2) * t;
  const pnlAt = (S: number) => positionValue(legs, m, { S, at: horizon }).pnl;
  const pnlNow = positionValue(legs, m).pnl; // unrealized P&L today (vs entry)

  // Expectation over the lognormal by Gauss-style quadrature on z ∈ [-8, 8].
  const N = 2001,
    zmax = 8,
    dz = (2 * zmax) / (N - 1);
  let pop = 0,
    popNow = 0,
    ev = 0,
    wsum = 0;
  for (let i = 0; i < N; i++) {
    const z = -zmax + i * dz,
      w = normPdf(z) * dz * (i === 0 || i === N - 1 ? 0.5 : 1);
    const p = pnlAt(m.S * Math.exp(drift + sq * z));
    if (p > 0.005) pop += w;
    if (p > pnlNow + 0.005) popNow += w;
    ev += w * p;
    wsum += w;
  }
  pop /= wsum;
  popNow /= wsum;
  ev /= wsum;

  // Breakevens: sign changes on a dense log grid, refined by bisection.
  const lo = m.S * Math.exp(drift - 6 * sq),
    hi = m.S * Math.exp(drift + 6 * sq),
    G = 1200;
  const xs = Array.from({ length: G }, (_, i) => lo * (hi / lo) ** (i / (G - 1)));
  const ys = xs.map(pnlAt);
  const breakevens: number[] = [];
  for (let i = 1; i < G; i++) {
    const a = ys[i - 1]!,
      b = ys[i]!;
    if (a === 0) breakevens.push(xs[i - 1]!);
    else if (Math.sign(a) !== Math.sign(b) && b !== 0) breakevens.push(bisect(pnlAt, xs[i - 1]!, xs[i]!, 1e-6));
  }
  // Max profit / loss over S ∈ [0, ∞): scan wide, and test the slope far out for unboundedness.
  const wide = [0.0001, ...xs, m.S * 3, m.S * 5, m.S * 10];
  const vals = wide.map(pnlAt);
  const farSlope = (pnlAt(m.S * 40) - pnlAt(m.S * 20)) / (m.S * 20);
  const maxProfit = farSlope > 1e-6 ? null : Math.max(...vals);
  const maxLoss = farSlope < -1e-6 ? null : Math.min(...vals);
  const strikes = [...new Set(legs.filter((l) => l.strike).map((l) => l.strike!))].sort((a, b) => a - b);
  return {
    horizon: new Date(horizon).toISOString(),
    daysToHorizon: rnd(t * 365, 2),
    sigmaUsed: rnd(sigma, 4),
    drift: o.drift ?? 'riskneutral',
    probabilityOfProfit: rnd(pop, 4),
    expectedValue: rnd(ev, 2), // expected P&L at horizon vs ENTRY cost
    unrealizedPnlNow: rnd(pnlNow, 2),
    probProfitFromNow: rnd(popNow, 4), // P(position worth more at horizon than it is today)
    expectedValueFromNow: rnd(ev - pnlNow, 2), // expected change from today's mark to horizon
    breakevens: breakevens.map((b) => rnd(b, 2)),
    maxProfit: maxProfit == null ? 'unlimited' : rnd(maxProfit, 2),
    maxLoss: maxLoss == null ? 'unlimited' : rnd(maxLoss, 2),
    expectedMove1Sigma: rnd(m.S * sigma * Math.sqrt(t), 2),
    oneSigmaRange: [rnd(m.S * Math.exp(drift - sq), 2), rnd(m.S * Math.exp(drift + sq), 2)],
    strikes: strikes.map((K) => ({
      strike: K,
      probAbove: rnd(probAbove(m.S, K, t, sigma, mu, 0), 4),
      probTouch: rnd(probTouch(m.S, K, t, sigma, mu, 0), 4),
    })),
  };
}

/** Distribution quantiles of S at horizon (handy for "what price is 10% likely"). */
export const priceQuantile = (S: number, t: number, sigma: number, p: number, mu = 0): number =>
  S * Math.exp((mu - (sigma * sigma) / 2) * t + sigma * Math.sqrt(t) * normInv(p));
