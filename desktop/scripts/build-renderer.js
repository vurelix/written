#!/usr/bin/env node
'use strict';

/*
 * build-renderer.js — regenerates renderer/index.html from the app source.
 *
 * Why this exists: renderer/index.html used to be a hand-patched COPY of
 * `Written v2.dc.html`. Every time the app changed, someone had to rediscover and redo
 * four separate edits by hand. This script makes that reproducible and self-verifying.
 *
 *   node scripts/build-renderer.js [--src <path to .dc.html>] [--check]
 *
 *   --check  verify the committed renderer/index.html matches what this script would
 *            generate, without writing (use in CI / before packaging).
 *
 * The app's own logic block is never touched; only wrapper concerns are injected.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'index.html');

// Source resolution order. `app-src/` makes the synced build copy self-sufficient:
// it lives outside iCloud and has no sibling app source, but packaging happens there,
// so the staleness gate has to work there too.
// Two names are accepted. `Written v2.dc.html` is checked FIRST on purpose: the
// original working folder still contains a stale `Written.dc.html` from an older
// build, and preferring the v2 name there avoids silently compiling the wrong app.
// The repository has only `Written.dc.html`, so it resolves correctly either way.
const APP_NAMES = ['Written v2.dc.html', 'Written.dc.html'];
const SRC_DIRS = [
  path.join(ROOT, 'app-src'),        // synced build copy
  path.resolve(ROOT, '..', 'app'),   // git repo layout
  path.resolve(ROOT, '..')           // original working folder
];
const SRC_CANDIDATES = SRC_DIRS.flatMap(d => APP_NAMES.map(n => path.join(d, n)));

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const srcIdx = argv.indexOf('--src');
const SRC = srcIdx !== -1
  ? path.resolve(argv[srcIdx + 1])
  : (SRC_CANDIDATES.find(p => fs.existsSync(p)) || SRC_CANDIDATES[0]);

const CSP =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'self'; " +
  // unsafe-eval is REQUIRED: the dc-runtime evaluates the x-dc logic block via
  // `new Function(...)` (support.js:774). Removing it breaks the app.
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  'img-src \'self\' data: blob:; ' +      // base64 trade screenshots
  'media-src \'self\' data: blob:; ' +    // trade videos
  "font-src 'self' data:; " +
  "connect-src 'self' file: data: blob:; " +
  "worker-src 'self' blob:" +
  '">';

// Injected before support.js. ORDER IS LOAD-BEARING:
//   - vendored React/ReactDOM must exist before support.js so it skips its CDN loader
//   - store-shim.js must run before the app reads localStorage
//   - perf.js must run before first paint so there is no flash of the heavy state
const HEAD_BLOCK = [
  CSP,
  '<link rel="stylesheet" href="./vendor/fonts.css">',
  '<link rel="stylesheet" href="./native-chrome.css">',
  '<link rel="stylesheet" href="./perf.css">',
  '<script src="./perf.js"></script>',
  '<script src="./vendor/react.production.min.js"></script>',
  '<script src="./vendor/react-dom.production.min.js"></script>',
  '<script src="./store-shim.js"></script>'
].join('\n');

const SUPPORT_TAG = '<script src="./support.js"></script>';
const BODY_TAG = '<script src="./native-chrome.js"></script>';

const GOOGLE_PRECONNECT = '<link rel="preconnect" href="https://fonts.googleapis.com">\n';
const GOOGLE_FONTS_RE = /<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*" rel="stylesheet">\n?/;

function fail(msg) {
  console.error('build-renderer: ' + msg);
  process.exit(1);
}

function build(src) {
  let s = src;

  // 1) vendored deps + CSP + wrapper CSS, immediately before support.js
  if (s.split(SUPPORT_TAG).length - 1 !== 1) {
    fail(`expected exactly one \`${SUPPORT_TAG}\` in the source`);
  }
  s = s.replace(SUPPORT_TAG, HEAD_BLOCK + '\n' + SUPPORT_TAG);

  // 2) fonts served locally instead of from Google
  if (!GOOGLE_FONTS_RE.test(s)) fail('Google Fonts <link> not found — did the app template change?');
  s = s.replace(GOOGLE_PRECONNECT, '').replace(GOOGLE_FONTS_RE, '');

  // 3) native-chrome.js at the end of <body>
  if (s.split('</body>').length - 1 !== 1) fail('expected exactly one </body>');
  s = s.replace('</body>', BODY_TAG + '\n</body>');

  // 4) guard: nothing may still reach out to the network
  for (const bad of ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com']) {
    if (s.includes(bad)) fail(`remote reference survived: ${bad}`);
  }
  return s;
}

function logicBlock(html) {
  const m = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1] : null;
}

if (!fs.existsSync(SRC)) fail(`source not found: ${SRC}`);
const source = fs.readFileSync(SRC, 'utf8');
const built = build(source);

// The app's logic must survive the wrapping byte-for-byte.
const a = logicBlock(source), b = logicBlock(built);
if (!a || !b) fail('could not locate the x-dc logic block');
const ha = crypto.createHash('sha256').update(a).digest('hex');
const hb = crypto.createHash('sha256').update(b).digest('hex');
if (ha !== hb) fail('app logic block changed during wrapping — refusing to write');

// The dc-runtime ships alongside the app source and must match it.
const RUNTIME_SRC = path.join(path.dirname(SRC), 'support.js');
const RUNTIME_OUT = path.join(ROOT, 'renderer', 'support.js');
const runtimeInSync = () =>
  fs.existsSync(RUNTIME_SRC) && fs.existsSync(RUNTIME_OUT) &&
  fs.readFileSync(RUNTIME_SRC, 'utf8') === fs.readFileSync(RUNTIME_OUT, 'utf8');

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== built) {
    fail('renderer/index.html is STALE — run `npm run build:renderer`');
  }
  if (fs.existsSync(RUNTIME_SRC) && !runtimeInSync()) {
    fail('renderer/support.js is STALE — run `npm run build:renderer`');
  }
  console.log(`build-renderer: up to date (logic sha256 ${ha.slice(0, 12)}…)`);
} else {
  fs.writeFileSync(OUT, built, 'utf8');
  if (fs.existsSync(RUNTIME_SRC)) fs.copyFileSync(RUNTIME_SRC, RUNTIME_OUT);
  console.log(`build-renderer: wrote ${path.relative(ROOT, OUT)}`);
  console.log(`  source        : ${SRC}`);
  console.log(`  runtime       : ${fs.existsSync(RUNTIME_SRC) ? 'support.js synced' : 'support.js not found beside source'}`);
  console.log(`  logic sha256  : ${ha.slice(0, 12)}… (unchanged)`);
}
