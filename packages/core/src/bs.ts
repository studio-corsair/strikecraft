// Black-Scholes-Merton (continuous dividend yield q) pricing, full greeks, implied vol,
// and a CRR binomial for American exercise. Conventions match thinkorswim:
//   theta  = $ per CALENDAR day (per share), vega = $ per 1 vol point, rho = $ per 1% rate.
//   vanna  = d(delta)/d(vol point), charm = delta change per calendar day, vomma = d(vega)/d(vol point).
import { normCdf as N, normPdf as n } from './math.ts';

export type Right = 'C' | 'P';
export interface BSInput {
  S: number;
  K: number;
  T: number;
  r: number;
  q: number;
  sigma: number;
  right: Right;
}

export function d1d2({ S, K, T, r, q, sigma }: BSInput): { d1: number; d2: number } {
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / sq;
  return { d1, d2: d1 - sq };
}

/** Intrinsic value. */
export const intrinsic = (S: number, K: number, right: Right): number => Math.max(right === 'C' ? S - K : K - S, 0);

/** European BSM price per share. */
export function bsPrice(p: BSInput): number {
  const { S, K, T, r, q, sigma, right } = p;
  if (T <= 0 || sigma <= 0) {
    // At expiry (or zero vol) the value is the discounted forward intrinsic.
    const F = S * Math.exp((r - q) * Math.max(T, 0)),
      df = Math.exp(-r * Math.max(T, 0));
    return df * intrinsic(F, K, right);
  }
  const { d1, d2 } = d1d2(p);
  const dq = Math.exp(-q * T),
    dr = Math.exp(-r * T);
  return right === 'C' ? S * dq * N(d1) - K * dr * N(d2) : K * dr * N(-d2) - S * dq * N(-d1);
}

/**
 * Full analytic greeks. Raw (per-year, per-1.00) values are in `raw`; the top-level fields
 * use trader units (see header).
 */
export function bsGreeks(p: BSInput) {
  const { S, K, T, r, q, sigma, right } = p;
  const price = bsPrice(p);
  if (T <= 0 || sigma <= 0) {
    const itm = right === 'C' ? S > K : S < K;
    return {
      price,
      delta: itm ? (right === 'C' ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
      vanna: 0,
      charm: 0,
      vomma: 0,
      speed: 0,
      d1: NaN,
      d2: NaN,
      raw: null,
    };
  }
  const { d1, d2 } = d1d2(p);
  const sqT = Math.sqrt(T),
    dq = Math.exp(-q * T),
    dr = Math.exp(-r * T),
    pd1 = n(d1);
  const call = right === 'C';
  const delta = call ? dq * N(d1) : dq * (N(d1) - 1);
  const gamma = (dq * pd1) / (S * sigma * sqT);
  const vega = S * dq * pd1 * sqT; // per 1.00 vol
  const common = (-S * dq * pd1 * sigma) / (2 * sqT);
  const theta = call
    ? common - r * K * dr * N(d2) + q * S * dq * N(d1)
    : common + r * K * dr * N(-d2) - q * S * dq * N(-d1); // per year
  const rho = call ? K * T * dr * N(d2) : -K * T * dr * N(-d2); // per 1.00 rate
  const vanna = (-dq * pd1 * d2) / sigma; // d delta / d sigma (per 1.00)
  const charmCore = (dq * pd1 * (2 * (r - q) * T - d2 * sigma * sqT)) / (2 * T * sigma * sqT);
  const charm = call ? q * dq * N(d1) - charmCore : -q * dq * N(-d1) - charmCore; // d delta / d t (per year, t = calendar time passing)
  const vomma = (vega * d1 * d2) / sigma; // d vega / d sigma (per 1.00)
  const speed = (-gamma / S) * (d1 / (sigma * sqT) + 1); // d gamma / dS
  return {
    price,
    delta,
    gamma,
    theta: theta / 365,
    vega: vega / 100,
    rho: rho / 100,
    vanna: vanna / 100,
    charm: charm / 365,
    vomma: vomma / 10000,
    speed,
    d1,
    d2,
    raw: { theta, vega, rho, vanna, charm, vomma },
  };
}

/**
 * No-arbitrage price bounds for a European option.
 */
export function priceBounds({ S, K, T, r, q, right }: Omit<BSInput, 'sigma'>): { lo: number; hi: number } {
  const dq = Math.exp(-q * T),
    dr = Math.exp(-r * T);
  return right === 'C'
    ? { lo: Math.max(S * dq - K * dr, 0), hi: S * dq }
    : { lo: Math.max(K * dr - S * dq, 0), hi: K * dr };
}

/**
 * Implied volatility from a price. Newton-Raphson with a bisection safeguard.
 * Returns null when the price violates no-arbitrage bounds (stale prints, crossed quotes).
 */
export function impliedVol(price: number, p: Omit<BSInput, 'sigma'>): number | null {
  if (!(price > 0) || !(p.T > 0)) return null;
  const { lo: plo, hi: phi } = priceBounds(p);
  if (price <= plo + 1e-10 || price >= phi) return null;
  let lo = 1e-4,
    hi = 10;
  // Brenner-Subrahmanyam ATM guess.
  let s = Math.min(Math.max((Math.sqrt((2 * Math.PI) / p.T) * price) / p.S, 0.05), 3);
  for (let i = 0; i < 100; i++) {
    const f = bsPrice({ ...p, sigma: s }) - price;
    if (Math.abs(f) < 1e-10) return s;
    if (f > 0) hi = s;
    else lo = s;
    const v = bsGreeks({ ...p, sigma: s }).raw?.vega ?? 0;
    let next = v > 1e-12 ? s - f / v : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - s) < 1e-12) return next;
    s = next;
  }
  return s;
}

/**
 * Cox-Ross-Rubinstein binomial tree with continuous dividend yield; American or European.
 */
export function crrPrice({
  S,
  K,
  T,
  r,
  q,
  sigma,
  right,
  american = true,
  steps = 500,
}: BSInput & { american?: boolean; steps?: number }): number {
  if (T <= 0) return intrinsic(S, K, right);
  const dt = T / steps,
    u = Math.exp(sigma * Math.sqrt(dt)),
    d = 1 / u;
  const disc = Math.exp(-r * dt),
    pu = (Math.exp((r - q) * dt) - d) / (u - d),
    pd = 1 - pu;
  const v = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) v[i] = intrinsic(S * u ** (steps - 2 * i), K, right);
  for (let j = steps - 1; j >= 0; j--) {
    for (let i = 0; i <= j; i++) {
      const cont = disc * (pu * v[i]! + pd * v[i + 1]!);
      v[i] = american ? Math.max(cont, intrinsic(S * u ** (j - 2 * i), K, right)) : cont;
    }
  }
  return v[0]!;
}

/**
 * Price + greeks under a chosen model. 'bs' = analytic European; 'american' = CRR with
 * finite-difference greeks (used for puts / dividend calls where early exercise matters).
 */
export function priceAndGreeks(p: BSInput, model: 'bs' | 'american' = 'bs') {
  if (model === 'bs' || p.T <= 0) return bsGreeks(p);
  const f = (o: Partial<BSInput>) => crrPrice({ ...p, ...o, american: true, steps: 400 });
  const price = f({});
  const hS = p.S * 0.005,
    hV = 0.005,
    hT = 1 / 365;
  const up = f({ S: p.S + hS }),
    dn = f({ S: p.S - hS });
  const delta = (up - dn) / (2 * hS),
    gamma = (up - 2 * price + dn) / (hS * hS);
  const vega = (f({ sigma: p.sigma + hV }) - f({ sigma: Math.max(p.sigma - hV, 1e-4) })) / (2 * hV) / 100;
  const theta = p.T > hT ? f({ T: p.T - hT }) - price : intrinsic(p.S, p.K, p.right) - price;
  const rho = (f({ r: p.r + 0.0005 }) - f({ r: p.r - 0.0005 })) / 0.001 / 100;
  const e = bsGreeks(p); // higher-order greeks: European approximation
  return { ...e, price, delta, gamma, theta, vega, rho };
}
