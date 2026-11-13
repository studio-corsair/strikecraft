#!/usr/bin/env node
// Screenshot a screen at phone and desktop widths, optionally after applying a strategy, and
// print console errors. Usage: node scripts/shot.mjs <base-url> <out-dir> [hash-route] [--strategy "Call vertical"] [--section Risk]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const [base, out, route = 'analyze'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const strategy = flag('strategy');
const section = flag('section');
if (!base || !out) {
  console.error('usage: shot.mjs <base-url> <out-dir> [route] [--strategy NAME] [--section NAME]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let failed = false;
for (const [name, width, height] of [
  ['phone', 360, 780],
  ['tablet', 820, 1180],
  ['desktop', 1440, 900],
]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: name === 'phone' ? 2 : 1 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/${route}`);
  await page.waitForSelector('[data-testid=last-price]', { timeout: 15000 });
  if (strategy) {
    if (name === 'phone' && route === 'analyze') await page.getByRole('tab', { name: 'Position' }).click();
    await page.getByRole('button', { name: strategy, exact: true }).click();
    await page.waitForSelector('[data-testid=pop]', { state: 'attached', timeout: 15000 });
  }
  if (section && name === 'phone') await page.getByRole('tab', { name: section, exact: true }).click();
  await page.waitForTimeout(400);
  const file = `${out}/${route}${strategy ? '-' + strategy.replace(/\W+/g, '_') : ''}${section && name === 'phone' ? '-' + section : ''}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`${file}  overflow=${overflow}px  errors=${errors.length}`);
  for (const e of errors) console.log(`  console error: ${e}`);
  if (errors.length || overflow > 0) failed = true;
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
