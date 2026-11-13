#!/usr/bin/env node
// Check a deployed (or locally served) STATIC demo: every screen renders on simulated data, an
// order goes through the in-browser paper account, and the page makes no request to any other
// origin and none to /api (there is no server behind the demo).
//   node scripts/demo-check.mjs <base-url>      exit 1 on any failure
import { chromium } from '@playwright/test';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: demo-check.mjs <base-url>');
  process.exit(2);
}
const origin = new URL(base).origin;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
const foreign = [];
const api = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.protocol === 'data:' || u.protocol === 'blob:') return;
  if (u.origin !== origin) foreign.push(r.url());
  else if (u.pathname.startsWith('/api/')) api.push(r.url());
});
const step = async (name, fn) => {
  await fn();
  console.log(`ok   ${name}`);
};
let failed = false;
try {
  await step('analyze renders a position and its odds', async () => {
    await page.goto(`${base}/analyze`);
    await page.getByTestId('last-price').waitFor();
    await page.getByRole('tab', { name: 'Odds' }).click();
    await page.getByTestId('pop').waitFor();
  });
  await step('data source is labelled as simulated', async () => {
    const t = await page.getByTestId('quote-source').innerText();
    if (!/Simulated demo data/.test(t)) throw new Error(`source pill says "${t}"`);
  });
  await step('trade: pick a contract, preview, send to the paper account', async () => {
    await page.goto(`${base}/trade`);
    await page.getByRole('button', { name: /^Buy 185 call at the ask/ }).click();
    await page.getByRole('tab', { name: /^Ticket/ }).click();
    await page.getByRole('button', { name: 'Preview order' }).click();
    await page.getByTestId('order-preview').waitFor();
    await page.getByRole('button', { name: 'Send to Paper account' }).click();
    await page.getByTestId('order-row').first().waitFor();
  });
  await step('earnings shows an implied move', async () => {
    await page.goto(`${base}/earnings`);
    await page.getByTestId('implied-move').waitFor();
  });
  await step('brokers explains the demo and cannot connect', async () => {
    await page.goto(`${base}/connections`);
    await page.getByText('The demo runs on simulated data').first().waitFor();
  });
  await step('installable: manifest and service worker are served', async () => {
    for (const p of ['/manifest.webmanifest', '/sw.js', '/icon-192.png']) {
      const r = await page.request.get(base + p);
      if (!r.ok()) throw new Error(`${p} → HTTP ${r.status()}`);
    }
  });
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.message.split('\n')[0]}`);
}
console.log(`console errors: ${errors.length}${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
console.log(
  `requests to other origins: ${foreign.length}${foreign.length ? ' → ' + foreign.slice(0, 3).join(' ') : ''}`,
);
console.log(`requests to /api: ${api.length}`);
await browser.close();
if (failed || errors.length || foreign.length || api.length) {
  console.log(`DEMO CHECK FAIL ${base}`);
  process.exit(1);
}
console.log(`DEMO CHECK PASS ${base}`);
