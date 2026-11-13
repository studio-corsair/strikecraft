// Numerical primitives. Zero dependencies.

/** Standard normal pdf. */
export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/**
 * Standard normal cdf, Hart (1968) double-precision algorithm as given by West (2005),
 * "Better approximations to cumulative normal functions". Absolute error < 1e-14.
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c;
  if (z > 37) c = 0;
  else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/**
 * Inverse standard normal cdf (Acklam's rational approximation + one Halley refinement).
 * @param p in (0,1)
 */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ] as const;
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572] as const;
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ] as const;
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416] as const;
  const pl = 0.02425;
  let x;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5,
      r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
export const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** Sample standard deviation. */
export const stdev = (xs: number[]): number => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Round to n significant decimals, keeping JSON tidy. */
export const rnd = (x: number | null | undefined, n = 4): number | null =>
  x == null || !Number.isFinite(x) ? null : +x.toFixed(n);

/**
 * Find a root of f in [lo,hi] by bisection (f(lo), f(hi) must differ in sign).
 */
export function bisect(f: (x: number) => number, lo: number, hi: number, tol = 1e-9, iters = 200): number {
  let flo = f(lo);
  for (let i = 0; i < iters && hi - lo > tol; i++) {
    const m = (lo + hi) / 2,
      fm = f(m);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = m;
      flo = fm;
    } else hi = m;
  }
  return (lo + hi) / 2;
}
