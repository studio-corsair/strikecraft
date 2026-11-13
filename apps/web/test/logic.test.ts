import { describe, it, expect } from 'vitest';
import {
  usd,
  usdCompact,
  pct,
  signedPct,
  num,
  price,
  expiryLabel,
  legLabel,
  pnlClass,
  sessionLabel,
  sourceText,
  sourceKind,
} from '../src/format.ts';
import { buildStrategy, nearestIndex, wingStep, addLeg, legKey, STRATEGIES } from '../src/strategies.ts';
import { buildOrder, netMid, lotsOf, priceLabel, occSymbol, contractWords, sideWords } from '../src/ticket.ts';
import { ticks } from '../src/components/RiskChart.tsx';
import { chartRange, shortDate } from '../src/screens/Analyze.tsx';
import { occ } from '@strikecraft/data';

describe('formatting', () => {
  it('formats money, including negatives and missing values', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(-12)).toBe('−$12.00');
    expect(usd(null)).toBe('–');
    expect(usd(NaN)).toBe('–');
    expect(usdCompact(22181.32)).toBe('$22.2k');
    expect(usdCompact(-47100)).toBe('−$47.1k');
    expect(usdCompact(626826)).toBe('$627k');
    expect(usdCompact(1_250_000)).toBe('$1.25M');
    expect(usdCompact(278.2)).toBe('$278');
    expect(usdCompact(undefined)).toBe('–');
  });
  it('formats percentages, counts and prices', () => {
    expect(pct(0.569)).toBe('56.9%');
    expect(pct(0.2546, 0)).toBe('25%');
    expect(pct(null)).toBe('–');
    expect(signedPct(2.828)).toBe('+2.83%');
    expect(signedPct(-5, 0)).toBe('−5%');
    expect(signedPct(0, 0)).toBe('0%');
    expect(num(3668.01)).toBe('3,668');
    expect(num(-29.47, 1)).toBe('−29.5');
    expect(price(170.891)).toBe('170.89');
    expect(price(undefined)).toBe('–');
  });
  it('labels expiries, legs, sessions and sources', () => {
    expect(expiryLabel('2026-12-18')).toBe("Dec 18 '26");
    expect(legLabel({ qty: 1, type: 'C', strike: 185, expiry: '2026-12-18' })).toBe("+1 Dec 18 '26 185 Call");
    expect(legLabel({ qty: -2, type: 'P', strike: 170, expiry: '2026-11-20' })).toBe("−2 Nov 20 '26 170 Put");
    expect(legLabel({ qty: 100, type: 'S' })).toBe('+100 shares');
    expect(pnlClass(5)).toBe('gain');
    expect(pnlClass(-5)).toBe('loss');
    expect(pnlClass(0)).toBe('');
    expect(pnlClass(null)).toBe('');
    expect(sessionLabel('pre')).toBe('pre-market');
    expect(sessionLabel('closed')).toBe('market closed');
    const t = { sourceLabel: 'Tradier', delayed: false, delayMinutes: 0 };
    expect(sourceText({ source: 'tradier', ...t })).toBe('Tradier · real-time');
    expect(sourceText({ source: 'yahoo', sourceLabel: 'Yahoo', delayed: true, delayMinutes: 15 })).toBe(
      'Yahoo · 15-min delayed',
    );
    expect(sourceText({ source: 'demo', sourceLabel: 'Simulated demo data', delayed: true, delayMinutes: 0 })).toBe(
      'Simulated demo data',
    );
    expect(sourceKind({ source: 'demo', delayed: true })).toBe('demo');
    expect(sourceKind({ source: 'yahoo', delayed: true })).toBe('delayed');
    expect(sourceKind({ source: 'tradier', delayed: false })).toBe('live');
  });
});

describe('strategy templates', () => {
  const strikes = [150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200];
  const ctx = { spot: 170.89, strikes, expiry: '2026-12-18', laterExpiry: '2027-01-15' };
  it('finds the at-the-money strike and a wing about 5% wide', () => {
    expect(strikes[nearestIndex(strikes, 170.89)]).toBe(170);
    expect(strikes[nearestIndex(strikes, 172.6)]).toBe(175);
    expect(wingStep(strikes, 170.89)).toBe(2); // 5% of 171 ≈ 8.5 → two $5 strikes
    expect(wingStep([100], 100)).toBe(1);
  });
  it('builds each strategy from listed strikes', () => {
    expect(buildStrategy('long-call', ctx)).toEqual([{ qty: 1, type: 'C', strike: 180, expiry: '2026-12-18' }]);
    expect(buildStrategy('vertical', ctx).map((l) => [l.qty, l.type, l.strike])).toEqual([
      [1, 'C', 170],
      [-1, 'C', 180],
    ]);
    expect(buildStrategy('put-vertical', ctx).map((l) => [l.qty, l.type, l.strike])).toEqual([
      [1, 'P', 170],
      [-1, 'P', 160],
    ]);
    expect(buildStrategy('straddle', ctx).map((l) => [l.qty, l.type, l.strike])).toEqual([
      [1, 'C', 170],
      [1, 'P', 170],
    ]);
    expect(buildStrategy('butterfly', ctx).map((l) => [l.qty, l.strike])).toEqual([
      [1, 160],
      [-2, 170],
      [1, 180],
    ]);
    expect(buildStrategy('iron-condor', ctx).map((l) => [l.qty, l.type, l.strike])).toEqual([
      [1, 'P', 150],
      [-1, 'P', 160],
      [-1, 'C', 180],
      [1, 'C', 190],
    ]);
    expect(buildStrategy('calendar', ctx).map((l) => [l.qty, l.strike, l.expiry])).toEqual([
      [-1, 170, '2026-12-18'],
      [1, 170, '2027-01-15'],
    ]);
    expect(buildStrategy('covered-call', ctx)).toEqual([
      { qty: 100, type: 'S' },
      { qty: -1, type: 'C', strike: 180, expiry: '2026-12-18' },
    ]);
  });
  it('every template yields legs on listed strikes, and wings clamp at the edge of the chain', () => {
    for (const s of STRATEGIES) {
      const legs = buildStrategy(s.id, ctx);
      expect(legs.length).toBeGreaterThan(0);
      for (const l of legs) if (l.type !== 'S') expect(strikes).toContain(l.strike);
    }
    expect(buildStrategy('iron-condor', { ...ctx, spot: 199 }).every((l) => strikes.includes(l.strike!))).toBe(true);
  });
  it('explains what is missing', () => {
    expect(() => buildStrategy('calendar', { ...ctx, laterExpiry: null })).toThrow('needs a later expiry');
    expect(() => buildStrategy('vertical', { ...ctx, strikes: [] })).toThrow('no strikes loaded');
  });
  it('merges legs on the same contract and drops a leg that nets to zero', () => {
    const a = { qty: 1, type: 'C' as const, strike: 185, expiry: '2026-12-18' };
    expect(legKey(a)).toBe('C:185:2026-12-18');
    expect(addLeg([a], a)).toEqual([{ ...a, qty: 2 }]);
    expect(addLeg([a], { ...a, qty: -1 })).toEqual([]);
    expect(addLeg([a], { ...a, type: 'P' })).toHaveLength(2);
  });
});

describe('order ticket', () => {
  const call = (qty: number, strike: number) => ({ qty, type: 'C' as const, strike, expiry: '2026-12-18' });
  it('uses the same OCC symbols as the data layer', () => {
    expect(occSymbol('nvda', '2026-12-18', 'C', 185)).toBe('NVDA261218C00185000');
    expect(occSymbol('SPY', '2027-01-15', 'P', 642.5)).toBe(occ('SPY', '2027-01-15', 'P', 642.5));
    expect(contractWords('NVDA261218C00185000')).toBe("Dec 18 '26 185 Call");
    expect(contractWords('SPY270115P00642500')).toBe("Jan 15 '27 642.5 Put");
    expect(contractWords('NVDA')).toBe('NVDA shares');
    expect(sideWords('sell_to_open')).toBe('Sell to open');
  });
  it('nets a package at the mid in its smallest ratio', () => {
    expect(netMid([call(1, 170), call(-1, 180)], [10.75, 6.42])).toBeCloseTo(4.33, 10);
    expect(netMid([call(2, 170), call(-2, 180)], [10.75, 6.42])).toBeCloseTo(4.33, 10);
    expect(lotsOf([call(2, 170), call(-2, 180)])).toBe(2);
    expect(netMid([call(-1, 170), call(1, 180)], [10.75, 6.42])).toBeCloseTo(-4.33, 10); // a credit
    expect(netMid([call(1, 170), call(-2, 180)], [10.75, 6.42])).toBeCloseTo(-2.09, 10); // 1×2 ratio
    expect(netMid([{ qty: 100, type: 'S' }, call(-1, 180)], [170.89, 6.42])).toBeCloseTo(164.47, 10); // covered call
    expect(netMid([call(1, 170)], [null])).toBeNull();
    expect(netMid([], [])).toBeNull();
  });
  it('builds single-leg, debit, credit, even and market orders', () => {
    const o = { symbol: 'nvda', intent: 'open' as const, duration: 'day' as const };
    expect(buildOrder([call(2, 185)], { ...o, price: 4.71, net: 4.7 })).toEqual({
      underlying: 'NVDA',
      legs: [{ symbol: 'NVDA261218C00185000', side: 'buy_to_open', quantity: 2 }],
      duration: 'day',
      type: 'limit',
      price: 4.71,
    });
    const debit = buildOrder([call(1, 170), call(-1, 180)], { ...o, price: 4.3, net: 4.33 });
    expect(debit).toMatchObject({ type: 'debit', price: 4.3 });
    expect(debit.legs.map((l) => l.side)).toEqual(['buy_to_open', 'sell_to_open']);
    expect(buildOrder([call(-1, 170), call(1, 180)], { ...o, price: 4.3, net: -4.33 })).toMatchObject({
      type: 'credit',
      price: 4.3,
    });
    expect(buildOrder([call(1, 170), call(-1, 180)], { ...o, price: 0, net: 0 }).type).toBe('even');
    expect(buildOrder([call(1, 170)], { ...o, price: null, net: null })).toMatchObject({ type: 'market' });
    const closing = buildOrder([call(-1, 170)], { ...o, intent: 'close', price: 10, net: -10 });
    expect(closing.legs[0]!.side).toBe('sell_to_close');
    expect(buildOrder([{ qty: -100, type: 'S' }], { ...o, price: 170, net: -170 }).legs[0]).toEqual({
      symbol: 'NVDA',
      side: 'sell',
      quantity: 100,
    });
    expect(priceLabel(debit)).toBe('Net debit 4.30');
    expect(priceLabel({ ...debit, type: 'market', price: undefined })).toBe('Market');
  });
  it('refuses an empty or unpriced ticket', () => {
    const o = { symbol: 'NVDA', intent: 'open' as const, duration: 'day' as const, net: 1 };
    expect(() => buildOrder([], { ...o, price: 1 })).toThrow('add at least one leg');
    expect(() => buildOrder([call(1, 170)], { ...o, price: 0 })).toThrow('price above zero');
    expect(() => buildOrder([call(1, 170)], { ...o, price: -1 })).toThrow('cannot be negative');
    expect(() => buildOrder([{ qty: 1, type: 'C' }], { ...o, price: 1 })).toThrow('needs a strike and an expiry');
  });
});

describe('chart helpers', () => {
  it('picks round tick values', () => {
    expect(ticks(120, 240, 6)).toEqual([120, 140, 160, 180, 200, 220, 240]);
    expect(ticks(-642, 2100, 5)).toEqual([0, 1000, 2000]);
    expect(ticks(-642, 2100, 6)).toEqual([-500, 0, 500, 1000, 1500, 2000]);
    expect(ticks(5, 5, 4)).toEqual([5]);
  });
  it('covers every strike with room, never narrower than ±20%', () => {
    const r = chartRange([{ qty: 1, type: 'C', strike: 180, expiry: '2026-12-04' }], 170.89);
    expect(r).toHaveLength(81);
    expect(r[0]).toBeCloseTo(-20, 3);
    expect(r[80]).toBeCloseTo(20, 3);
    const wide = chartRange([{ qty: 1, type: 'C', strike: 260, expiry: '2026-12-04' }], 170.89);
    expect(170.89 * (1 + wide[80]! / 100)).toBeCloseTo(286, 0);
    expect(chartRange([{ qty: 100, type: 'S' }], 100)[0]).toBeCloseTo(-20, 3);
  });
  it('shortens risk-grid date labels', () => {
    expect(shortDate('now (T+0)')).toBe('now');
    expect(shortDate('expiry 2026-12-18')).toBe('expiry Dec 18');
    expect(shortDate('2026-11-24')).toBe('Nov 24');
    expect(shortDate('something else')).toBe('something else');
  });
});
