#!/usr/bin/env node
// Regenerate the README screenshots from the DEMO (simulated data only, never a real account).
//   node scripts/readme-shots.mjs <base-url-of-a-demo-server>
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: readme-shots.mjs <base-url>');
  process.exit(2);
}
const out = 'docs/img';
fs.mkdirSync(out, { recursive: true });
const CONDOR = [
  { qty: 1, type: 'P', strike: 150, expiry: '2026-12-18' },
  { qty: -1, type: 'P', strike: 160, expiry: '2026-12-18' },
  { qty: -1, type: 'C', strike: 185, expiry: '2026-12-18' },
  { qty: 1, type: 'C', strike: 195, expiry: '2026-12-18' },
];
const CALL = [{ qty: 2, type: 'C', strike: 185, expiry: '2026-12-18' }];
const browser = await chromium.launch();

async function shot(name, { width, height, path, legs, prepare, scale = 2 }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.addInitScript((l) => {
    localStorage.setItem('sb.symbol', JSON.stringify('NVDA'));
    localStorage.setItem('sb.legs', JSON.stringify(l));
    sessionStorage.setItem('sb.seeded', '1');
  }, legs);
  await page.goto(base + path);
  // Screenshots may only ever come from demo data: a server that cannot prove it is the demo is refused.
  const res = await page.request.get(base + '/api/status');
  const status = res.ok() ? await res.json() : null;
  if (status?.mode !== 'demo') throw new Error(`refusing to take README screenshots: ${base} is not a demo server`);
  await page.getByTestId('last-price').waitFor();
  if (prepare) await prepare(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
  await page.close();
}

await shot('analyze-desktop', {
  width: 1440,
  height: 1000,
  path: '/analyze',
  legs: CONDOR,
  scale: 1,
  prepare: (p) => p.getByTestId('pop').waitFor(),
});
await shot('analyze-phone', {
  width: 390,
  height: 844,
  path: '/analyze',
  legs: CONDOR,
  prepare: async (p) => {
    await p.getByRole('tab', { name: 'Risk' }).click();
    await p.getByRole('img', { name: /^Risk profile/ }).waitFor();
  },
});
await shot('trade-phone', {
  width: 390,
  height: 844,
  path: '/trade',
  legs: [],
  prepare: (p) => p.getByRole('button', { name: /^Buy 170 call at the ask/ }).waitFor(),
});
await shot('trade-desktop', {
  width: 1440,
  height: 1000,
  path: '/trade',
  legs: CALL,
  scale: 1,
  prepare: async (p) => {
    await p.getByRole('button', { name: 'Preview order' }).click();
    await p.getByTestId('order-preview').waitFor();
  },
});
await shot('earnings-phone', {
  width: 390,
  height: 844,
  path: '/earnings',
  legs: CALL,
  prepare: async (p) => {
    await p.getByRole('tab', { name: 'History' }).click();
    await p.waitForTimeout(300);
  },
});
await shot('earnings-desktop', {
  width: 1440,
  height: 1000,
  path: '/earnings',
  legs: CALL,
  scale: 1,
  prepare: (p) => p.getByTestId('implied-move').waitFor(),
});
await browser.close();
