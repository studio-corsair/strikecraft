#!/usr/bin/env node
// Print the layout shifts of a page load at phone width, with the elements that moved.
//   node scripts/cls.mjs <url> [width] [api-delay-ms]   (the delay shows every loading state, as a slow phone would)
import { chromium } from '@playwright/test';
const [url, width = '390', delay = '0'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: 844 } });
await page.addInitScript(() => {
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__shifts.push({
        t: Math.round(e.startTime),
        value: +e.value.toFixed(4),
        nodes: (e.sources ?? []).slice(0, 4).map((s) => {
          const n = s.node;
          const name =
            n && n.nodeType === 1
              ? `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]}`
              : String(n?.nodeName);
          return `${name} y${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`;
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
});
if (Number(delay) > 0)
  await page.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, Number(delay)));
    await route.continue();
  });
await page.goto(url);
await page.waitForTimeout(3500 + 6 * Number(delay));
const shifts = await page.evaluate(() => window.__shifts);
let total = 0;
for (const s of shifts) {
  total += s.value;
  console.log(`${String(s.t).padStart(5)}ms  ${s.value.toFixed(4)}  ${s.nodes.join(' | ')}`);
}
console.log(`CLS ${total.toFixed(3)} (${shifts.length} shifts) ${url} @${width}`);
await browser.close();
process.exit(total > 0.1 ? 1 : 0);
