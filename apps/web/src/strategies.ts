// Strategy templates: turn "iron condor on this expiry" into concrete legs using the strikes
// that actually exist in the chain. Pure, unit-tested.
import type { LegInput } from './api.ts';

export type StrategyId =
  | 'long-call'
  | 'long-put'
  | 'vertical'
  | 'put-vertical'
  | 'straddle'
  | 'strangle'
  | 'butterfly'
  | 'iron-condor'
  | 'calendar'
  | 'diagonal'
  | 'ratio'
  | 'covered-call';

export const STRATEGIES: { id: StrategyId; label: string; needsLaterExpiry?: boolean }[] = [
  { id: 'long-call', label: 'Long call' },
  { id: 'long-put', label: 'Long put' },
  { id: 'vertical', label: 'Call vertical' },
  { id: 'put-vertical', label: 'Put vertical' },
  { id: 'straddle', label: 'Straddle' },
  { id: 'strangle', label: 'Strangle' },
  { id: 'butterfly', label: 'Butterfly' },
  { id: 'iron-condor', label: 'Iron condor' },
  { id: 'calendar', label: 'Calendar', needsLaterExpiry: true },
  { id: 'diagonal', label: 'Diagonal', needsLaterExpiry: true },
  { id: 'ratio', label: 'Ratio' },
  { id: 'covered-call', label: 'Covered call' },
];

export interface StrategyContext {
  /** Underlying price. */
  spot: number;
  /** Strikes listed for the expiry, ascending. */
  strikes: number[];
  expiry: string;
  /** A later expiry, for calendars and diagonals. */
  laterExpiry?: string | null;
}

/** Index of the listed strike nearest a price. */
export function nearestIndex(strikes: number[], target: number): number {
  let best = 0;
  for (let i = 1; i < strikes.length; i++)
    if (Math.abs(strikes[i]! - target) < Math.abs(strikes[best]! - target)) best = i;
  return best;
}

/**
 * How many strikes make one "step" for wings: about 5% of spot, at least one strike, so a vertical
 * on a $170 stock with $2.50 strikes is ~$7.50 wide rather than one strike wide.
 */
export function wingStep(strikes: number[], spot: number): number {
  if (strikes.length < 2) return 1;
  const atm = nearestIndex(strikes, spot);
  const gap =
    Math.abs((strikes[Math.min(atm + 1, strikes.length - 1)] ?? 0) - (strikes[Math.max(atm - 1, 0)] ?? 0)) / 2 || 1;
  return Math.max(1, Math.round((spot * 0.05) / gap));
}

export function buildStrategy(id: StrategyId, c: StrategyContext): LegInput[] {
  const { strikes, spot, expiry } = c;
  if (!strikes.length) throw new Error('this expiry has no strikes loaded yet');
  const atm = nearestIndex(strikes, spot);
  const step = wingStep(strikes, spot);
  const at = (i: number) => strikes[Math.min(strikes.length - 1, Math.max(0, i))]!;
  const call = (qty: number, strike: number, exp = expiry): LegInput => ({ qty, type: 'C', strike, expiry: exp });
  const put = (qty: number, strike: number, exp = expiry): LegInput => ({ qty, type: 'P', strike, expiry: exp });
  const later = () => {
    if (!c.laterExpiry) throw new Error('a calendar or diagonal needs a later expiry, and this is the last one listed');
    return c.laterExpiry;
  };
  switch (id) {
    case 'long-call':
      return [call(1, at(atm + step))];
    case 'long-put':
      return [put(1, at(atm - step))];
    case 'vertical':
      return [call(1, at(atm)), call(-1, at(atm + step))];
    case 'put-vertical':
      return [put(1, at(atm)), put(-1, at(atm - step))];
    case 'straddle':
      return [call(1, at(atm)), put(1, at(atm))];
    case 'strangle':
      return [call(1, at(atm + step)), put(1, at(atm - step))];
    case 'butterfly':
      return [call(1, at(atm - step)), call(-2, at(atm)), call(1, at(atm + step))];
    case 'iron-condor':
      return [
        put(1, at(atm - 2 * step)),
        put(-1, at(atm - step)),
        call(-1, at(atm + step)),
        call(1, at(atm + 2 * step)),
      ];
    case 'calendar':
      return [call(-1, at(atm)), call(1, at(atm), later())];
    case 'diagonal':
      return [call(-1, at(atm + step)), call(1, at(atm), later())];
    case 'ratio':
      return [call(1, at(atm)), call(-2, at(atm + step))];
    case 'covered-call':
      return [{ qty: 100, type: 'S' }, call(-1, at(atm + step))];
  }
}

/** A stable key for a leg, for React lists and de-duplication. */
export const legKey = (l: LegInput): string => (l.type === 'S' ? 'S' : `${l.type}:${l.strike}:${l.expiry}`);

/** Merge a leg into a position: same instrument adds quantities; a net zero removes it. */
export function addLeg(legs: LegInput[], leg: LegInput): LegInput[] {
  const i = legs.findIndex((l) => legKey(l) === legKey(leg));
  if (i < 0) return [...legs, leg];
  const qty = legs[i]!.qty + leg.qty;
  return qty === 0 ? legs.filter((_, j) => j !== i) : legs.map((l, j) => (j === i ? { ...l, qty } : l));
}
