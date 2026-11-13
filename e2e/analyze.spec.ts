// Analyze screen: every number on screen equals what packages/core computes for the same inputs.
// The page runs against the demo server (simulated, deterministic market); the test computes the
// expected values in-process from the same demo data with the core functions.
import { test, expect } from '@playwright/test';
import { positionValue, probability, cost, parseLeg } from '@strikebench/core';
import { createEngine, createLadder, demoSource, defaultDemoSnapshots } from '@strikebench/data';
import { usd, usdCompact, pct, num } from '../apps/web/src/format.ts';

const LEGS = [
  { qty: 2, type: 'C', strike: 185, expiry: '2026-12-18', entry: 4.71 },
  { qty: -2, type: 'C', strike: 200, expiry: '2026-12-18', entry: 1.9 },
];

async function expected() {
  const demo = demoSource(defaultDemoSnapshots());
  const engine = createEngine(createLadder([demo]), { now: () => demo.asOf });
  const ms = await engine.marketState('NVDA');
  const legs = [parseLeg('+2 C 185 2026-12-18 @4.71'), parseLeg('-2 C 200 2026-12-18 @1.90')];
  await engine.fillLegs(legs, ms); // IV from the demo chain, exactly as the app does
  const market = { S: ms.S, r: ms.r, q: ms.q, now: ms.now, model: 'bs' as const };
  return { v: positionValue(legs, market), p: probability(legs, market), cost: cost(legs) };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((legs) => {
    localStorage.setItem('sb.symbol', JSON.stringify('NVDA'));
    localStorage.setItem('sb.legs', JSON.stringify(legs));
  }, LEGS);
});

test('position, greeks and probabilities match the core math', async ({ page }) => {
  const { v, p, cost: c } = await expected();
  expect(c).toBeCloseTo(562, 6); // 2 × 100 × (4.71 − 1.90)
  await page.goto('/analyze');
  await expect(page.getByTestId('open-pnl')).toHaveText(usdCompact(v.pnl));
  const greeks = page.getByTestId('greeks');
  await expect(greeks).toContainText(`Delta (shares)${num(v.delta)}`);
  await expect(greeks).toContainText(`Theta / day${usd(v.theta, 0)}`);
  await expect(greeks).toContainText(`Vega / vol pt${usd(v.vega, 0)}`);
  await expect(page.getByTestId('pop')).toHaveText(pct(p.probabilityOfProfit, 0));
  const odds = page.getByRole('region', { name: /^Probability to/ });
  await expect(odds).toContainText(`Break-even${usd(p.breakevens[0] as number)}`);
  await expect(odds).toContainText(`Max loss${usdCompact(p.maxLoss as number)}`);
  await expect(odds).toContainText(`Max profit${usdCompact(p.maxProfit as number)}`);
  // A 185/200 call spread bought for 2.81: the textbook bounds, independent of any model.
  expect(p.maxLoss).toBeCloseTo(-562, 2);
  expect(p.maxProfit).toBeCloseTo((15 - 2.81) * 200, 2);
  expect(p.breakevens[0]).toBeCloseTo(187.81, 2);
});

test('the scenario grid is the position repriced at each move, and names the data source', async ({ page }) => {
  await page.goto('/analyze');
  const grid = page.getByRole('region', { name: 'Scenario grid: P&L vs entry' });
  // At expiry far below the strikes the spread is worth nothing: the full debit is lost.
  await expect(
    grid
      .getByRole('row', { name: /^expiry Dec 18/ })
      .getByRole('cell')
      .nth(1),
  ).toHaveText(usdCompact(-562));
  await expect(page.getByTestId('quote-source')).toHaveText('Simulated demo data');
  await expect(page.getByRole('img', { name: /^Risk profile for NVDA/ })).toBeVisible();
});

test('changing the IV shift redraws the curve; a strategy replaces the position', async ({ page }) => {
  await page.goto('/analyze');
  const chart = page.getByRole('img', { name: /^Risk profile for NVDA/ });
  await expect(chart).toBeVisible();
  const before = await chart.locator('path').nth(2).getAttribute('d');
  await page.getByRole('button', { name: 'IV +15' }).click();
  await expect(page.getByRole('button', { name: 'IV +15' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => chart.locator('path').nth(2).getAttribute('d')).not.toBe(before);
  await page.getByRole('button', { name: 'Iron condor', exact: true }).click();
  await expect(page.getByTestId('leg')).toHaveCount(4);
  await expect(page.getByRole('region', { name: /^Probability to/ })).toContainText('Max profit');
  await page.getByRole('button', { name: 'Clear position' }).click();
  await expect(page.getByTestId('leg')).toHaveCount(0);
});
