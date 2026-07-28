#!/usr/bin/env node
'use strict';

/*
 * sync.js — copy the canonical wrapper sources to a build/run directory.
 *
 * Why this exists: packaging needs a working tree outside iCloud, because iCloud Drive
 * stamps un-removable `com.apple.FinderInfo` xattrs that invalidate Electron's code
 * signature (macOS then SIGKILLs it). So there are two copies: the canonical sources
 * here in the git repo, and a runnable/buildable copy at the destination.
 *
 * The flow is STRICTLY ONE-DIRECTIONAL — repo -> dest. The destination is disposable;
 * never edit it and never copy back from it. Keeping copies in sync by hand already
 * caused a bug (a test harness silently ran stale code), and letting three copies
 * diverge cost an entire release cycle of drift.
 *
 *   node scripts/sync.js [dest]      (default: ~/Developer/written-desktop)
 *
 * node_modules/ and dist/ are never touched, so the destination keeps its install
 * and its build output. Every synced DIRECTORY is mirrored (removed first), so a file
 * deleted or renamed here cannot survive at the destination as an orphan.
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
  // package-lock.json and test/ ride along so the synced copy can install and run the
  // Playwright smoke suite (see playwright.config.js). Without them `npm run test:smoke`
  // only works in the iCloud source tree, which is the one place Electron cannot run.
  'package-lock.json',
  'playwright.config.js',
  'test',
  'README.md',
  // Both licence files are electron-builder `extraResources`, so they must exist beside
  // package.json in the SYNCED copy — that is where packaging actually runs. Omitting
  // LICENSE here is why `extraResources: "../LICENSE"` looked fine in the repo and would
  // have failed in the only tree that can produce a build.
  'LICENSE',
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
  // Mirror directories rather than merge into them. `cpSync` only ever adds and
  // overwrites, so a renamed file (titlebar.js -> native-chrome.js) or a dropped font
  // lingers at the destination forever and eventually gets shipped.
  if (fs.statSync(from).isDirectory()) fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, force: true });
  copied++;
}

// The app source itself, so `npm run verify:renderer` works in the destination.
// Packaging runs there, and that is exactly where a stale renderer must be caught.
// It is build input only — `files` in package.json does not ship app-src/.
//
// Probe both layouts, mirroring SRC_DIRS in build-renderer.js: `app/` is the git repo,
// the bare parent is the legacy working folder this project grew up in.
const APP_NAME = 'Written.dc.html';
const APP_SRC = [
  path.resolve(ROOT, '..', 'app', APP_NAME),
  path.resolve(ROOT, '..', APP_NAME)
].find(p => fs.existsSync(p));

if (APP_SRC) {
  const dir = path.join(dest, 'app-src');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(APP_SRC, path.join(dir, APP_NAME));
  copied++;
  console.log('  + app-src/' + APP_NAME + ' (build input for verify:renderer)');

  // build-renderer.js compares renderer/support.js against the copy sitting beside the
  // app source, so that sibling has to come along or the staleness gate cannot run.
  const RUNTIME_SRC = path.join(path.dirname(APP_SRC), 'support.js');
  if (fs.existsSync(RUNTIME_SRC)) {
    fs.copyFileSync(RUNTIME_SRC, path.join(dir, 'support.js'));
    copied++;
    console.log('  + app-src/support.js (dc-runtime, for the staleness check)');
  } else {
    console.warn('  ! support.js not found beside the app source — the staleness check will skip it');
  }
} else {
  console.warn('  ! app source not found in app/ or the parent dir — verify:renderer will fail in dest');
}

console.log(`sync: copied ${copied} entries`);
console.log(`  from : ${ROOT}`);
console.log(`  to   : ${dest}`);
console.log('  (node_modules/ and dist/ left untouched)');
