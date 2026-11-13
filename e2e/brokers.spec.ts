// Brokers screen on the demo: the catalog, the data-source ladder, and the order-safety switch
// (which the demo refuses to turn on, with the reason shown).
import { test, expect } from '@playwright/test';

test('lists every broker, the data ladder and where keys are kept', async ({ page }) => {
  await page.goto('/connections');
  const brokers = page.getByRole('region', { name: 'Brokers' });
  for (const name of [
    'Tradier',
    'tastytrade',
    'Charles Schwab',
    'Interactive Brokers',
    'Alpaca',
    'TradeStation',
    'E*TRADE',
  ])
    await expect(brokers).toContainText(name);
  await expect(brokers).toContainText('The demo runs on simulated data');
  const ladder = page.getByRole('region', { name: 'Market data' });
  await expect(ladder).toContainText('Simulated demo data');
  await expect(ladder).toContainText('The first source that answers wins');
  const about = page.getByRole('region', { name: 'About this install' });
  await expect(about).toContainText('Demo');
  await expect(about).toContainText('Paper account');
});

test('the broker table sorts by any column', async ({ page }) => {
  await page.goto('/connections');
  const table = page.getByRole('region', { name: 'Brokers' }).getByRole('table');
  const names = () => table.locator('tbody tr th, tbody tr td:first-child').allInnerTexts();
  const broker = table.getByRole('columnheader', { name: /^Broker/ });
  await broker.getByRole('button').click();
  await expect(broker).toHaveAttribute('aria-sort', 'ascending');
  const asc = (await names()).filter((t) => /^[A-Za-z*]/.test(t)).map((t) => t.split('\n')[0]!.toLowerCase());
  expect(asc[0]).toBe('alpaca');
  await broker.getByRole('button').click();
  await expect(broker).toHaveAttribute('aria-sort', 'descending');
  for (const name of ['Status', 'Options orders', 'Multi-leg', 'Real-time option quotes', 'Paper trading', 'Sign-in']) {
    const h = table.getByRole('columnheader', { name: new RegExp(`^${name}`) });
    await h.getByRole('button').click();
    await expect(h).toHaveAttribute('aria-sort', /ascending|descending/);
  }
});

test('live orders are off, and turning them on takes a second step that the demo refuses', async ({ page }) => {
  await page.goto('/connections');
  const safety = page.getByRole('region', { name: 'Order safety' });
  const toggle = safety.getByRole('switch', { name: 'Allow live orders' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); // one click is not enough
  const confirm = safety.getByRole('group', { name: 'Confirm live orders' });
  await expect(confirm).toContainText('real money');
  await confirm.getByRole('button', { name: 'Keep off' }).click();
  await expect(confirm).toHaveCount(0);
  await toggle.click();
  await safety.getByRole('button', { name: 'Turn on live orders' }).click();
  await expect(safety.getByRole('alert')).toContainText('not available in the demo');
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); // the switch shows what the server says
});
