// LIVE check against the Tradier SANDBOX (paper money), entirely through the UI:
// connect the sandbox key on the Connections screen, place a 2-leg order on the Trade screen,
// see it working, cancel it. Never a live account: the test connects env=sandbox and asserts it.
// Needs TRADIER_SANDBOX_TOKEN (or ~/.secrets/tradier_sandbox_api_key); skipped without one.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tokenFile = path.join(os.homedir(), '.secrets', 'tradier_sandbox_api_key');
const TOKEN =
  process.env.TRADIER_SANDBOX_TOKEN ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');

let server: ChildProcess | null = null;
let base = '';
let home = '';

test.beforeAll(async () => {
  test.skip(!TOKEN, 'no Tradier sandbox token on this machine');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sandbox-e2e-'));
  server = spawn(
    process.execPath,
    ['apps/server/src/bin.ts', '--no-open', '--port', '0', '--static', 'apps/web/dist', '--data-dir', home],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  base = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 20000);
    server!.stdout!.on('data', (d: Buffer) => {
      const m = /running: (http:\/\/localhost:\d+)/.exec(String(d));
      if (m) {
        clearTimeout(t);
        resolve(m[1]!);
      }
    });
  });
});
test.afterAll(() => {
  server?.kill();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('connect the sandbox, place a 2-leg order through the UI, cancel it', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    localStorage.setItem('sb.symbol', JSON.stringify('NVDA'));
    localStorage.setItem('sb.legs', JSON.stringify([]));
    sessionStorage.setItem('sb.seeded', '1');
  });
  page.on('response', async (r) => {
    if (r.url().includes('/api/orders'))
      console.log(r.request().method(), new URL(r.url()).pathname, r.status(), (await r.text()).slice(0, 160));
  });
  await page.goto(`${base}/connections`);
  await page.getByRole('button', { name: 'Connect Tradier' }).click();
  const form = page.getByRole('form', { name: 'Connect Tradier' });
  await expect(form.getByLabel('Environment')).toHaveValue('sandbox');
  await form.getByLabel('API token').fill(TOKEN);
  await form.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText(/Connected · sandbox/).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('body')).not.toContainText(TOKEN);

  await page.goto(`${base}/trade`);
  await expect(page.getByTestId('quote-source')).toContainText('Tradier sandbox');
  // Far out-of-the-money call vertical for one cent: it cannot fill, so it rests until canceled.
  await page.getByRole('button', { name: 'More strikes' }).click();
  await page.getByRole('button', { name: 'More strikes' }).click();
  const asks = page.getByRole('button', { name: /^Buy \d+(\.\d+)? call at the ask/ });
  const bids = page.getByRole('button', { name: /^Sell \d+(\.\d+)? call at the bid/ });
  const n = await asks.count();
  await asks.nth(n - 2).click();
  await bids.nth(n - 1).click();
  await expect(page.getByTestId('ticket-leg')).toHaveCount(2);
  await page.locator('#ticket-price').fill('0.01');
  await page.getByRole('button', { name: 'Preview order' }).click();
  const preview = page.getByTestId('order-preview');
  await expect(preview).toContainText('Sent toTradier sandbox', { timeout: 30000 });
  await expect(preview).toContainText('Buy to open');
  await expect(preview).toContainText('Sell to open');
  await preview.getByRole('button', { name: 'Send to Tradier sandbox' }).click();
  await expect(page.getByTestId('order-sent')).toContainText('sent to Tradier sandbox', { timeout: 30000 });
  const row = page.getByTestId('order-row').first();
  await expect(row).toHaveAttribute('data-state', /^(open|pending)$/);
  await row.getByRole('button', { name: /^Cancel order/ }).click();
  await expect(row).toHaveAttribute('data-state', 'canceled', { timeout: 30000 });
  // The key is on disk only in the config file, readable by the user alone (mode 0600 = 384).
  expect(fs.statSync(path.join(home, 'config.json')).mode % 512).toBe(384);
});
