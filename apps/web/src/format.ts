// Number and date formatting used across the UI. Pure functions, unit-tested.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DASH = '–';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** $1,234.56 (or –$12.00). */
export function usd(x: number | null | undefined, digits = 2): string {
  if (!finite(x)) return DASH;
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${x < 0 ? '−' : ''}$${s}`;
}

/** Compact dollars for big P&L numbers: $22.2k, −$47.1k, $1.25M, $278. */
export function usdCompact(x: number | null | undefined): string {
  if (!finite(x)) return DASH;
  const a = Math.abs(x);
  const sign = x < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e5) return `${sign}$${(a / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  return `${sign}$${a.toFixed(0)}`;
}

/** A plain price: 170.89. */
export const price = (x: number | null | undefined, digits = 2): string => (finite(x) ? x.toFixed(digits) : DASH);

/** 0.569 → "56.9%". */
export const pct = (x: number | null | undefined, digits = 1): string =>
  finite(x) ? `${(x * 100).toFixed(digits)}%` : DASH;

/** Already-in-percent with sign: 2.83 → "+2.83%". */
export const signedPct = (x: number | null | undefined, digits = 2): string =>
  finite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}%` : DASH;

/** 3668.01 → "3,668"; small numbers keep decimals. */
export function num(x: number | null | undefined, digits = 0): string {
  if (!finite(x)) return DASH;
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace('-', '−');
}

/** "2026-12-18" → "Dec 18 '26". */
export function expiryLabel(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return `${MONTHS[m - 1]} ${day} '${String(y).slice(2)}`;
}

/** "2026-12-18" → "12-18". */
export const expiryShort = (d: string): string => d.slice(5);

/** One leg as a trader would say it: "+1 Dec 18 '26 185 Call". */
export function legLabel(l: { qty: number; type: 'C' | 'P' | 'S'; strike?: number; expiry?: string }): string {
  const q = `${l.qty > 0 ? '+' : '−'}${Math.abs(l.qty)}`;
  if (l.type === 'S') return `${q} shares`;
  return `${q} ${expiryLabel(l.expiry ?? '')} ${l.strike} ${l.type === 'C' ? 'Call' : 'Put'}`;
}

export const pnlClass = (x: number | null | undefined): string =>
  !finite(x) || x === 0 ? '' : x > 0 ? 'gain' : 'loss';

/** "regular" → "market open", etc. */
export function sessionLabel(s: string): string {
  return s === 'regular' ? 'market open' : s === 'pre' ? 'pre-market' : s === 'post' ? 'after hours' : 'market closed';
}

/** Short clock time in the viewer's zone: "14:30". */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** What a source pill says: "Tradier · real-time", "Yahoo · 15-min delayed", "Simulated demo data". */
export function sourceText(t: { source: string; sourceLabel: string; delayed: boolean; delayMinutes: number }): string {
  if (t.source === 'demo') return t.sourceLabel;
  if (!t.delayed) return `${t.sourceLabel} · real-time`;
  return `${t.sourceLabel} · ${t.delayMinutes}-min delayed`;
}

export const sourceKind = (t: { source: string; delayed: boolean }): 'demo' | 'live' | 'delayed' =>
  t.source === 'demo' ? 'demo' : t.delayed ? 'delayed' : 'live';
