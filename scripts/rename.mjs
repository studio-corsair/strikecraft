#!/usr/bin/env node
// Rename the product everywhere it is spelled out: package names, the CLI command, environment
// variables, the data directory, UI strings, docs and the repository URL.
//   node scripts/rename.mjs <newname> [DisplayName] [--dry-run]
// <newname> is the lowercase npm/CLI name; DisplayName defaults to it with a capital first letter.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--dry-run');
const [next, displayArg] = args;
if (!next || !/^[a-z][a-z0-9-]{1,30}$/.test(next)) {
  console.error('usage: rename.mjs <newname> [DisplayName] [--dry-run]   (lowercase letters, digits, hyphens)');
  process.exit(2);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/core/package.json'), 'utf8'));
const prev = pkg.name.replace(/^@/, '').split('/')[0];
if (prev === next) {
  console.log(`already named ${next}`);
  process.exit(0);
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const Display = displayArg ?? cap(next);
const PrevDisplay = cap(prev);
const pairs = [
  [prev.toUpperCase(), next.toUpperCase().replace(/-/g, '_')], // STRIKECRAFT_PORT → NEW_PORT
  [PrevDisplay, Display], // prose and UI
  [prev, next], // package names, CLI, paths, URLs
];

// Tracked text files only; binary files and the record of the old name's check are left alone.
const files = execFileSync('git', ['ls-files'], { cwd: root })
  .toString()
  .split('\n')
  .filter(Boolean)
  .filter(
    (f) => !/\.(png|jpg|ico|woff2|tgz)$/.test(f) && !f.startsWith('docs/name-check/') && f !== 'package-lock.json',
  );

let changed = 0;
for (const rel of files) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [a, b] of pairs) after = after.split(a).join(b);
  if (after !== before) {
    changed++;
    if (!dry) fs.writeFileSync(file, after);
  }
}
const oldDir = path.join(root, 'packages', prev);
const newDir = path.join(root, 'packages', next);
const moveDir = fs.existsSync(oldDir) && !fs.existsSync(newDir);
console.log(
  `${dry ? 'would rename' : 'renamed'} ${prev} → ${next} ("${PrevDisplay}" → "${Display}") in ${changed} files${moveDir ? `, packages/${prev} → packages/${next}` : ''}`,
);
if (dry) process.exit(0);
if (moveDir) execFileSync('git', ['mv', `packages/${prev}`, `packages/${next}`], { cwd: root, stdio: 'inherit' });
// The lockfile and node_modules links carry the old workspace names: rebuild them.
fs.rmSync(path.join(root, 'package-lock.json'), { force: true });
fs.rmSync(path.join(root, 'node_modules', `@${prev}`), { recursive: true, force: true });
execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
console.log('done. Next: npm run check:full, npx playwright test, and rename the GitHub repository.');
