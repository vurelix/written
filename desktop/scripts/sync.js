#!/usr/bin/env node
'use strict';

/*
 * sync.js — copy the canonical wrapper sources to a build/run directory.
 *
 * Why this exists: this project cannot be run or packaged from ~/Documents, because
 * iCloud Drive stamps un-removable `com.apple.FinderInfo` xattrs that invalidate
 * Electron's code signature (macOS then SIGKILLs it). So there are two copies:
 * canonical sources here, and a runnable/buildable copy outside iCloud.
 *
 * Keeping them in sync BY HAND already caused a bug — a test harness silently ran
 * stale code. This script makes it one command.
 *
 *   node scripts/sync.js [dest]      (default: ~/Developer/written-desktop)
 *
 * node_modules/ and dist/ are never touched, so the destination keeps its install
 * and its build output.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const dest = path.resolve(process.argv[2] || path.join(os.homedir(), 'Developer', 'written-desktop'));

// Everything the app needs at runtime/build time. node_modules and dist are excluded
// by omission — they belong to the destination, not the source.
const ITEMS = [
  'main.js',
  'preload.js',
  'ipc-channels.js',
  'package.json',
  'README.md',
  'THIRD-PARTY-LICENSES.txt',
  'build',
  'scripts',
  'renderer'
];

if (dest === ROOT) {
  console.error('sync: destination is the source directory — nothing to do');
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });

let copied = 0;
for (const item of ITEMS) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) continue;
  const to = path.join(dest, item);
  fs.cpSync(from, to, { recursive: true, force: true });
  copied++;
}

// The app source itself, so `npm run verify:renderer` works in the destination.
// Packaging runs there, and that is exactly where a stale renderer must be caught.
// It is build input only — `files` in package.json does not ship app-src/.
const APP_SRC = path.resolve(ROOT, '..', 'Written v2.dc.html');
if (fs.existsSync(APP_SRC)) {
  const dir = path.join(dest, 'app-src');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(APP_SRC, path.join(dir, 'Written v2.dc.html'));
  copied++;
  console.log('  + app-src/Written v2.dc.html (build input for verify:renderer)');
} else {
  console.warn('  ! app source not found next to the project — verify:renderer will fail in dest');
}

console.log(`sync: copied ${copied} entries`);
console.log(`  from : ${ROOT}`);
console.log(`  to   : ${dest}`);
console.log('  (node_modules/ and dist/ left untouched)');
