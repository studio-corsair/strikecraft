// Trade screen on the demo: build an order in the chain, preview it, send it to the paper
// account, see it working, cancel it; and a marketable order fills and becomes a position.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sb.symbol', JSON.stringify('NVDA'));
    localStorage.setItem('sb.legs', JSON.stringify([]));
    sessionStorage.setItem('sb.seeded', '1');
  });
});

test('a resting limit order is previewed, sent, listed as open, then canceled', async ({ page }) => {
  await page.goto('/trade');
  await page.getByRole('button', { name: /^Buy 185 call at the ask/ }).click();
  await expect(page.getByTestId('ticket-leg')).toHaveCount(1);
  await page.getByLabel(/^Limit price/).fill('0.05');
  await page.getByRole('button', { name: 'Preview order' }).click();
  const preview = page.getByTestId('order-preview');
  await expect(preview).toContainText('Limit 0.05');
  await expect(preview).toContainText('Buy to open');
  await expect(preview).toContainText('Estimated cost$5.00');
  await expect(preview).toContainText('below the current mid'); // the broker's warning is shown before sending
  await preview.getByRole('button', { name: 'Send to Paper account' }).click();
  await expect(page.getByTestId('order-sent')).toContainText('sent to Paper account: open');
  // The paper account is shared by every test in the run: find this test's own order.
  const row = page
    .getByTestId('order-row')
    .filter({ hasText: /185 Call\s*limit 0\.05/ })
    .first();
  await expect(row).toHaveAttribute('data-state', 'open');
  await expect(row).toContainText("Buy to open 1 Dec 4 '26 185 Call");
  await row.getByRole('button', { name: /^Cancel order/ }).click();
  await expect(row).toHaveAttribute('data-state', 'canceled');
  await expect(row.getByRole('button', { name: /^Cancel order/ })).toBeDisabled();
});

test('a two-leg vertical at the mid fills and can be analyzed as a position', async ({ page }) => {
  await page.goto('/trade');
  await page.getByRole('button', { name: /^Buy 175 call at the ask/ }).click();
  await page.getByRole('button', { name: /^Sell 185 call at the bid/ }).click();
  await expect(page.getByTestId('ticket-leg')).toHaveCount(2);
  await expect(page.getByLabel(/^Net debit/)).toBeVisible();
  await page.getByRole('button', { name: 'Preview order' }).click();
  const preview = page.getByTestId('order-preview');
  await expect(preview).toContainText('Net debit');
  await expect(preview).toContainText('Sell to open');
  await preview.getByRole('button', { name: 'Send to Paper account' }).click();
  await expect(page.getByTestId('order-row').filter({ hasText: '175 Call' }).first()).toHaveAttribute(
    'data-state',
    'filled',
  );
  await page.getByRole('button', { name: 'Analyze my NVDA position' }).click();
  await expect(page).toHaveURL(/\/analyze$/);
  await expect(page.getByTestId('leg')).toHaveCount(2);
  await expect(page.getByTestId('pop')).toBeVisible();
});

test('editing the ticket after a preview withdraws the Send button', async ({ page }) => {
  await page.goto('/trade');
  await page.getByRole('button', { name: /^Buy 185 call at the ask/ }).click();
  await page.getByRole('button', { name: 'Preview order' }).click();
  await expect(page.getByTestId('order-preview')).toBeVisible();
  await page.getByLabel(/^Quantity for/).fill('3');
  await expect(page.getByTestId('order-preview')).toHaveCount(0); // what is sent is always what was previewed
  await page.getByRole('button', { name: /^Remove .* from the ticket/ }).click();
  await expect(page.getByTestId('ticket-leg')).toHaveCount(0);
});
