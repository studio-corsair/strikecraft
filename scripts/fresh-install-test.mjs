#!/usr/bin/env node
// Fresh-machine install test for the published package: from a packed tarball, in an empty
// directory with an empty HOME and an empty npm cache, `npx strikebench` must start, serve the
// UI, answer the API, and render in a browser. Nothing from this repo is on its path.
//   node scripts/fresh-install-test.mjs [path/to/strikebench-x.y.z.tgz]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkgDir = path.join(root, 'packages/strikebench');
let tgz = process.argv[2];
if (!tgz) {
  execFileSync('node', [path.join(root, 'scripts/build-package.mjs')], { stdio: 'inherit' });
  const out = execFileSync('npm', ['pack', '--silent'], { cwd: pkgDir }).toString().trim().split('\n').pop();
  tgz = path.join(pkgDir, out);
}
tgz = path.resolve(tgz);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'strikebench-fresh-'));
const home = path.join(work, 'home');
const cwd = path.join(work, 'empty-dir');
fs.mkdirSync(home);
fs.mkdirSync(cwd);
// A clean environment: only PATH (for node/npm), an empty HOME and an empty npm cache.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  npm_config_cache: path.join(work, 'npm-cache'),
  npm_config_update_notifier: 'false',
};
const say = (s) => console.log(s);
let server;
let failed = false;
try {
  say(`tarball   ${path.basename(tgz)} (${(fs.statSync(tgz).size / 1024).toFixed(0)} kB)`);
  say(`clean dir ${cwd} (HOME and npm cache are empty temp dirs)`);
  const version = execFileSync('npx', ['--yes', `--package=${tgz}`, 'strikebench', '--version'], { cwd, env })
    .toString()
    .trim();
  say(`npx strikebench --version → ${version}`);
  const help = execFileSync('npx', ['--yes', `--package=${tgz}`, 'strikebench', '--help'], { cwd, env }).toString();
  if (!help.includes('Keys stay on this machine')) throw new Error('--help output is missing');

  server = spawn('npx', ['--yes', `--package=${tgz}`, 'strikebench', '--demo', '--no-open', '--port', '0'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stderr.on('data', (d) => (log += d));
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start: ${log}`)), 60000);
    server.stdout.on('data', (d) => {
      log += d;
      const m = /running: (http:\/\/localhost:\d+)/.exec(log);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    server.on('exit', (c) => reject(new Error(`server exited with ${c}: ${log}`)));
  });
  say(`npx strikebench --demo → ${log.trim().split('\n')[0]}`);
  if (log.includes('The UI is not built')) throw new Error('the package did not find its bundled UI');

  const status = await (await fetch(`${base}/api/status`)).json();
  say(`GET /api/status → mode=${status.mode} version=${status.version} brokers=${status.brokers.length}`);
  if (status.mode !== 'demo' || status.version !== version) throw new Error('unexpected status');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/analyze`);
  await page.getByTestId('last-price').waitFor();
  const price = await page.getByTestId('last-price').innerText();
  await page.getByRole('tab', { name: 'Odds' }).click();
  await page.getByTestId('pop').waitFor();
  const pop = await page.getByTestId('pop').innerText();
  const manifest = await page.request.get(`${base}/manifest.webmanifest`);
  const sw = await page.request.get(`${base}/sw.js`);
  const manifestName = manifest.ok() ? (await manifest.json()).name : null;
  await browser.close();
  say(`browser: /analyze rendered, NVDA ${price}, P(profit) ${pop}, console errors ${errors.length}`);
  say(`installable: manifest ${manifest.status()} (${manifestName}), service worker ${sw.status()}`);
  if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
  if (!manifest.ok() || !sw.ok()) throw new Error('manifest or service worker missing');
  // Demo mode must not create a key store.
  if (fs.existsSync(path.join(home, '.strikebench'))) throw new Error('demo mode wrote to ~/.strikebench');
  say('demo mode left HOME untouched (no ~/.strikebench)');
} catch (e) {
  failed = true;
  say(`FAIL ${e.message}`);
} finally {
  server?.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
say(failed ? 'FRESH INSTALL FAIL' : 'FRESH INSTALL PASS');
process.exit(failed ? 1 : 0);
