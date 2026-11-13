#!/usr/bin/env node
// Build the publishable `strikebench` package: the server bundled into one file plus the built UI.
//   node scripts/build-package.mjs   →  packages/strikebench/dist/{cli.mjs,web/}
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'packages/strikebench/dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

execFileSync('npm', ['run', '-s', 'build'], { cwd: root, stdio: 'inherit' });
fs.cpSync(path.join(root, 'apps/web/dist'), path.join(out, 'web'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'), // source maps stay out of the published package
});

await build({
  entryPoints: [path.join(root, 'apps/server/src/bin.ts')],
  outfile: path.join(out, 'cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
});
fs.chmodSync(path.join(out, 'cli.mjs'), 0o755);
for (const f of ['LICENSE', 'README.md'])
  if (fs.existsSync(path.join(root, f)))
    fs.copyFileSync(path.join(root, f), path.join(root, 'packages/strikebench', f));

const size = (p) => (fs.statSync(p).size / 1024).toFixed(0);
const web = fs.readdirSync(path.join(out, 'web'), { recursive: true }).length;
console.log(`built packages/strikebench/dist: cli.mjs ${size(path.join(out, 'cli.mjs'))} kB, web/ ${web} files`);
