import { describe, expect, it } from 'vitest';
import {
  buildExpiry,
  atmIv,
  ivAtDelta,
  straddle,
  maxPain,
  expirySummary,
  constantMaturityIv,
  eventVariance,
  type RawOptionRow,
} from '../src/chain.ts';
import { bsPrice } from '../src/bs.ts';
import { expiryMs } from '../src/position.ts';

const now = Date.parse('2026-11-13T15:00:00Z');
const S = 180,
  r = 0.04,
  q = 0;
// Synthetic chain priced off a known smile: vol(K) = 0.45 + 0.4·(ln(K/F))² − 0.15·ln(K/F)
function chain(expiry: string, smile = true, base = 0.45) {
  const T = (expiryMs(expiry) - now) / (365 * 864e5);
  const F = S * Math.exp(r * T);
  const vol = (K: number) => (smile ? base + 0.4 * Math.log(K / F) ** 2 - 0.15 * Math.log(K / F) : base);
  const calls: RawOptionRow[] = [],
    puts: RawOptionRow[] = [];
  for (let K = 120; K <= 250; K += 5) {
    const c = bsPrice({ S, K, T, r, q, sigma: vol(K), right: 'C' }),
      p = bsPrice({ S, K, T, r, q, sigma: vol(K), right: 'P' });
    calls.push({
      strike: K,
      bid: c * 0.99,
      ask: c * 1.01,
      lastPrice: c,
      openInterest: K === 180 ? 5000 : 100,
      volume: 10,
      contractSymbol: `C${K}`,
    });
    puts.push({
      strike: K,
      bid: p * 0.99,
      ask: p * 1.01,
      lastPrice: p,
      openInterest: K === 170 ? 9000 : 100,
      volume: 10,
      contractSymbol: `P${K}`,
    });
  }
  return { e: buildExpiry(calls, puts, { expiry, S, r, q, now }), vol, F, T };
}

describe('chain analytics on a synthetic smile', () => {
  it('recovers each contract IV from the mid', () => {
    const { e, vol } = chain('2026-12-18');
    const c = e.contracts.find((x) => x.right === 'C' && x.strike === 200)!;
    expect(c.iv!).toBeCloseTo(vol(200), 3);
    expect(c.markSource).toBe('mid');
  });
  it('ATM IV interpolates to the smile value at the forward', () => {
    const { e, vol, F } = chain('2026-12-18');
    expect(atmIv(e).iv!).toBeCloseTo(vol(F), 2);
  });
  it('put skew: 25Δ put IV > 25Δ call IV with negative slope smile', () => {
    const { e } = chain('2026-12-18');
    expect(ivAtDelta(e, 'P', 0.25)!).toBeGreaterThan(ivAtDelta(e, 'C', 0.25)!);
  });
  it('flat vol: straddle-implied 1σ ≈ σ√T and RR ≈ 0', () => {
    const { e, T } = chain('2026-12-18', false);
    const st = straddle(e)!;
    expect(st.implied1SigmaPct).toBeCloseTo(0.45 * Math.sqrt(T), 2);
    const s = expirySummary(e);
    expect(Math.abs(s.skew.riskReversal25!)).toBeLessThan(0.002);
  });
  it('max pain sits at the heavy-OI strikes', () => {
    const { e } = chain('2026-12-18');
    expect([170, 175, 180]).toContain(maxPain(e));
  });
  it('falls back to last trade and flags it when the quote is one-sided', () => {
    const e = buildExpiry([{ strike: 185, bid: 0, ask: 0, lastPrice: 5, contractSymbol: 'x' }], [], {
      expiry: '2026-12-18',
      S,
      r,
      q,
      now,
    });
    expect(e.contracts[0]!.markSource).toMatch(/^last/);
  });
});

describe('term structure', () => {
  it('constant-maturity IV interpolates in total variance', () => {
    const term = [
      { T: 10 / 365, iv: 0.6 },
      { T: 40 / 365, iv: 0.45 },
    ];
    const v30 = constantMaturityIv(term, 30)!;
    const w = (0.36 * 10 + (0.2025 * 40 - 0.36 * 10) * (20 / 30)) / 365;
    expect(v30).toBeCloseTo(Math.sqrt(w / (30 / 365)), 10);
  });
  it('event variance: recovers a planted 8% event move and ex-event vol 40%', () => {
    const E = 0.08,
      sx = 0.4;
    const mk = (expiry: string) => {
      const T = (expiryMs(expiry) - now) / (365 * 864e5);
      return { expiry, T, iv: Math.sqrt(sx * sx + (E * E) / T) };
    };
    const ev = eventVariance([mk('2026-11-20'), mk('2026-11-27')], '2026-11-17', 'AMC')!;
    expect(ev.eventMoveStd!).toBeCloseTo(E, 6);
    expect(ev.exEventVol!).toBeCloseTo(sx, 6);
    expect(ev.postEventIv!['2026-11-27']).toBeCloseTo(sx, 6);
  });
  it('prefers a pre-event expiry for the ex-event vol', () => {
    const now2 = now;
    const T = (d: string) => (expiryMs(d) - now2) / (365 * 864e5);
    const ev = eventVariance(
      [
        { expiry: '2026-11-16', T: T('2026-11-16'), iv: 0.4 },
        { expiry: '2026-11-20', T: T('2026-11-20'), iv: Math.sqrt(0.16 + 0.0064 / T('2026-11-20')) },
      ],
      '2026-11-17',
      'AMC',
    )!;
    expect(ev.method).toMatch(/pre-event/);
    expect(ev.eventMoveStd!).toBeCloseTo(0.08, 6);
  });
});

describe('off-hours data hygiene', () => {
  it('stale last trades get no IV; OI stats are null when Yahoo zeroed OI', () => {
    const markTime = 1_794_517_200;
    const rows = [
      {
        strike: 180,
        bid: 0,
        ask: 0,
        lastPrice: 8,
        lastTradeDate: markTime - 30,
        openInterest: 0,
        contractSymbol: 'fresh',
      },
      {
        strike: 185,
        bid: 0,
        ask: 0,
        lastPrice: 6,
        lastTradeDate: markTime - 3 * 3600,
        openInterest: 0,
        contractSymbol: 'stale',
      },
    ];
    const e = buildExpiry(rows, [], { expiry: '2026-12-18', S, r, q, now, markTime });
    expect(e.contracts[0]!.iv).not.toBeNull();
    expect(e.contracts[1]!.iv).toBeNull();
    expect(e.contracts[1]!.markSource).toMatch(/stale/);
    expect(maxPain(e)).toBeNull();
    expect(expirySummary(e).gexPer1PctUsd).toBeNull();
  });
});
