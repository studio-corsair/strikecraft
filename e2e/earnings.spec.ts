// Earnings screen on the demo: the implied move, the history table and its sorting, the IV
// crush, and the position's P&L through the print.
import { test, expect } from '@playwright/test';

const withLegs = (legs: unknown[], symbol = 'NVDA') =>
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([l, s]) => {
        localStorage.setItem('sb.symbol', JSON.stringify(s));
        localStorage.setItem('sb.legs', JSON.stringify(l));
        sessionStorage.setItem('sb.seeded', '1');
      },
      [legs, symbol] as const,
    );
  });

test.describe('with a position', () => {
  withLegs([{ qty: 1, type: 'C', strike: 185, expiry: '2026-12-18' }]);

  test('shows the implied move, the history against it, and the crush', async ({ page }) => {
    await page.goto('/earnings');
    const next = page.getByRole('region', { name: 'Next earnings' });
    await expect(page.getByTestId('implied-move')).toHaveText(/^±\d+\.\d\d%$/);
    await expect(next).toContainText('after close');
    await expect(next).toContainText('/ 20'); // quarters beating the implied move, out of 20
    await expect(page.getByRole('region', { name: 'IV crush' })).toContainText('Ex-event vol');
    const pos = page.getByRole('region', { name: 'Your position through the print' });
    await expect(pos).toContainText('Cost if flat after print');
    await expect(pos.getByRole('row')).not.toHaveCount(0);
  });

  test('every column of the past-reactions table sorts', async ({ page }) => {
    await page.goto('/earnings');
    const table = page.getByRole('region', { name: 'Past reactions' }).getByRole('table');
    const firstCell = (col: number) => table.locator('tbody tr').first().locator('td').nth(col);
    await expect(table.locator('tbody tr')).toHaveCount(20);
    const move = table.getByRole('columnheader', { name: /^Move/ });
    await move.getByRole('button').click();
    await expect(move).toHaveAttribute('aria-sort', /ascending|descending/);
    const a = await firstCell(4).innerText();
    await move.getByRole('button').click();
    const b = await firstCell(4).innerText();
    expect(a).not.toBe(b); // the order flipped
    const moves = (await table.locator('tbody tr td:nth-child(5)').allInnerTexts()).map((t) =>
      Number(t.replace('−', '-').replace('%', '')),
    );
    const sorted = [...moves].sort((x, y) => x - y);
    expect(moves.join()).toMatch(
      new RegExp(`^(${sorted.join()}|${[...sorted].reverse().join()})$`.replace(/[.+]/g, '\\$&')),
    );
    for (const name of ['Date', 'Timing', 'Close before', 'Close after', 'Gap']) {
      const h = table.getByRole('columnheader', { name: new RegExp(`^${name}`) });
      await h.getByRole('button').click();
      await expect(h).toHaveAttribute('aria-sort', /ascending|descending/);
    }
  });
});

test.describe('without a position', () => {
  withLegs([]);
  test('offers to build one on Analyze', async ({ page }) => {
    await page.goto('/earnings');
    const pos = page.getByRole('region', { name: 'Your position through the print' });
    await pos.getByRole('button').click();
    await expect(page).toHaveURL(/\/analyze$/);
  });
});

test.describe('a symbol with no earnings', () => {
  withLegs([], 'SPY');
  test('says so plainly instead of showing empty numbers', async ({ page }) => {
    await page.goto('/earnings');
    await expect(page.getByTestId('last-price')).toBeVisible();
    const body = page.locator('main');
    await expect(body).toContainText(/no upcoming earnings/i);
    await expect(body).not.toContainText(/NaN|undefined|null/);
  });
});
