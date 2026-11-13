#!/usr/bin/env node
// Render the PNG app icons from the SVG sources (run after changing an icon).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const dir = 'apps/web/public';
const jobs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
];
const browser = await chromium.launch();
for (const [src, out, size] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const svg = fs.readFileSync(`${dir}/${src}`, 'utf8');
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: `${dir}/${out}`, omitBackground: true });
  console.log(`${out} ${size}x${size}`);
  await page.close();
}
await browser.close();
