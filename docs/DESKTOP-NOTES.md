# Written — Desktop (macOS + Windows)

Electron wrapper around the existing `Written v2.dc.html` app. Everything here wraps *around* it —
the only edit ever made to the app itself is the **Performance** row in Settings (see below).
`scripts/build-renderer.js` verifies by sha256 that wrapping never alters the app's
`<script type="text/x-dc">` logic block.

---

## ⚠️ Read this first: don't run from `~/Documents`

This project lives in **iCloud Drive** (Desktop & Documents sync). iCloud's file provider stamps
un-removable `com.apple.FinderInfo` extended attributes on files, which **invalidates Electron's
code signature**. macOS then kills the binary instantly:

```
Electron.app/Contents/MacOS/Electron exited with signal SIGKILL
```

`xattr -cr` cannot clear it here, and `codesign` fails with
*"resource fork, Finder information, or similar detritus not allowed"*.

**Fix — copy the project to a local (non-synced) folder to run or package:**

```bash
mkdir -p ~/Developer && cp -R ~/Documents/"Trading Journal Dashboard UI"/desktop ~/Developer/written-desktop
cd ~/Developer/written-desktop && npm install && npm start
```

Keep editing sources in `~/Documents`, then push them across with one command — do **not** copy by
hand (that already caused a harness to run stale code):

```bash
npm run sync        # -> ~/Developer/written-desktop (node_modules/ and dist/ untouched)
```
Also note `node_modules/` (~300 MB) will otherwise be uploaded to iCloud — another reason to
keep the runnable copy outside `Documents`.

---

## Run

```bash
npm install
npm start
```

## Package

```bash
npm run dist:mac    # -> dist/macOS/
npm run dist:win    # -> dist/Windows/
```

Both write to their own platform folder. To build both architectures explicitly:

```bash
npx electron-builder --mac --arm64 --x64 --config.directories.output=dist/macOS
npx electron-builder --win --x64 --arm64 --config.directories.output=dist/Windows
```

### Build output (verified working)

**`dist/macOS/`**
| File | Size | For |
|---|---|---|
| `Written-1.0.0-arm64.dmg` | 92 MB | Apple Silicon |
| `Written-1.0.0.dmg` | 98 MB | Intel Macs |

**`dist/Windows/`**
| File | Size | For |
|---|---|---|
| `Written Setup 1.0.0.exe` | 154 MB | NSIS installer, contains **both** x64 and arm64 |

Windows installers build fine from macOS — electron-builder downloads its own bundled Wine
automatically. No manual Wine install needed.

### Before a real release

- **Icons.** `build/` is empty, so builds currently use the default Electron icon. Add
  `build/icon.icns` and `build/icon.ico` (1024×1024 source) and rebuild.
- **Signing.** macOS builds are **ad-hoc signed** by `build/afterPack.js` (see below). That is
  enough to run locally, but not for distribution — sending the DMG to someone else still needs a
  Developer ID + notarization. Windows is unsigned and shows a SmartScreen warning until you buy a
  code-signing certificate.

### Why `build/afterPack.js` exists (do not remove it)

electron-builder cannot ad-hoc sign on its own (`"identity": "-"` is treated as a keychain lookup
and silently skipped). Without the hook it ships the app carrying Electron's original
*linker-signed* stub, which no longer matches our modified bundle. The result:

```
$ codesign --verify --deep --strict Written.app
Written.app: code has no resources but signature indicates they must be present
```

macOS then refuses to launch it and reports **"Written is malware"** — a signature-validation
failure, not a real detection. The hook runs `codesign --force --deep --sign -` after packaging and
before the DMG is built, producing a valid signature (identifier `com.written.journal`). This is
mandatory on Apple Silicon, where arm64 binaries must carry a valid signature to execute at all.

---

## File map

| File | Purpose |
|---|---|
| `ipc-channels.js` | **Shared** IPC channel names + perf-mode contract, required by main *and* preload |
| `scripts/build-renderer.js` | Regenerates `renderer/index.html` from the app source (see below) |
| `scripts/sync.js` | Copies canonical sources to the runnable copy outside iCloud |
| `main.js` | Main process: window config (native chrome per-platform, min 800×600), atomic JSON file store, app menu |
| `preload.js` | `contextBridge` — exposes `window.desktopPlatform`, `window.desktopPrefs` (perf mode) and `window.desktopStore` (storage) |
| `renderer/index.html` | The app, patched: vendored scripts + CSP + title bar. App logic untouched |
| `renderer/support.js` | The dc-runtime, copied verbatim |
| `renderer/store-shim.js` | Redirects the 3 journal keys from `localStorage` to the file store |
| `renderer/native-chrome.{css,js}` | Hides the template's decorative `.traffic-dot`s and makes the app's own `.app-titlebar` the macOS drag region. Injects nothing |
| `renderer/perf.{css,js}` | Performance Mode rules + applier (see below) |
| `renderer/vendor/` | Offline React 18.3.1, ReactDOM, self-hosted fonts (324 KB total) |

## `renderer/index.html` is GENERATED — do not hand-edit

```bash
npm run build:renderer     # regenerate from ../Written v2.dc.html
npm run verify:renderer    # fail if the committed copy is stale (runs before every dist)
```

It applies only wrapper concerns — vendored scripts + `store-shim.js` + `perf.js` before
`support.js` (order is load-bearing), local fonts instead of Google's, `native-chrome.js` before
`</body>`, and a CSP `<meta>`. The script **refuses to write** if the app's `x-dc` logic block hash
changes, and fails if any remote reference survives.

Previously this file was a hand-patched copy, so every app update meant rediscovering four separate
edits by hand.

---

## Performance Mode (View menu)

**The problem, measured in Electron on a 120Hz ProMotion Mac:** the app composites ~18-20
`backdrop-filter` glass panels on top of large, continuously-animating layers (3x ~500px `aurora`
divs carrying `filter:blur(30px)`, plus `bgpan` / `glowpulse` / `pulse`). Every animation frame
forces all that glass to re-blur, so the GPU compositor presents only every 2nd-3rd display frame.

This is **not** a JavaScript problem. With vsync disabled the renderer produced frames in **0.4 ms**,
there were **zero long tasks**, and real work per keystroke is ~9 ms. It is purely GPU compositing.

| Mode | Median frame | fps | Glass panels | What you lose |
|---|---|---|---|---|
| `full` | 13.7-32 ms | 31-73 | 18 | nothing |
| **`reduced`** (default) | **8.3 ms** | **120** | **18 — kept** | perpetual motion (aurora drift, pulsing dot, entry animations) |
| `max` | **8.3 ms** | **120** | 0 | the above + frosted glass becomes solid |

Switch it two ways — they are **one setting**, not two:

- **Settings → Performance** in the app (between *Frosted glass* and *Default P&L view*)
- **View → Performance Mode** in the menu bar, or `Cmd/Ctrl+Alt+1/2/3`

Changing either updates the other: the in-app buttons call through to the main process
(`prefs:set-mode`), which persists the choice and rebuilds the menu radio; menu changes are
pushed back to the renderer (`prefs:perf-mode`). The choice lives in `desktop-prefs.json` in
the app-data folder — deliberately per-machine, not inside your journal profile, since it
describes this display's capability rather than your data. It is applied in `<head>` before
first paint, so there is no flash.

`reduced` is the default because it reaches a locked 120fps *while keeping every glass panel*, so the
design is visually intact. Transitions are left enabled in all modes — measured to cost nothing.

### Why the scrollbar lags behind, and slow dashboard paint

The app styles `::-webkit-scrollbar` (width:10px, custom thumb). Once a page styles the scrollbar,
Chromium stops using macOS's independently-composited **overlay** scrollbar and paints the thumb as
part of the page. So the thumb can only move as fast as the page paints — at 35fps the scrollbar
visibly trails the content. Raising the frame rate fixes it; there is nothing wrong with the
scroll handling itself (the app has no scroll listeners and no custom scrollbar JS).

Separately, `.calendar-scroll` is itself a `glass-surface`, so scrolling it forces a
`backdrop-filter` re-blur every frame — the pathological case for blur. `perf.css` therefore drops
backdrop-filter on scroll containers in **both** `reduced` and `max`, even though `reduced` keeps
glass everywhere else.

**Things that do NOT fix this** (all tested, so don't retry them):

- The app's own **Glass / Glow settings** — blur count stayed 18 even at `glass:off`, because many
  blurs are hardcoded (`blur(6px)`, `blur(9px)`…) rather than driven by `--surface-fx`.
- Targeting only the aurora layers (`div[style*="inset:-25%"] > div`) — 35fps, unchanged.
- `animation-iteration-count: 1` — those animations run 13-40s per cycle, so one iteration still
  animates continuously.
- `--disable-gpu-vsync` — "fixes" the number (2500fps) by decoupling from the display; causes
  tearing and wastes battery. Not a real fix.

---

## Data persistence

All journal data goes to a single JSON file, written atomically (tmp + rename):

- **macOS** — `~/Library/Application Support/Written/written-store.json`
- **Windows** — `%APPDATA%\Written\written-store.json`

`store-shim.js` patches `localStorage.getItem/setItem/removeItem` for exactly three keys —
`written-profiles-v2`, `written-settings-v1`, `written-data-v1` — reading from an in-memory cache
hydrated once at boot and debouncing writes (250 ms) back to disk. The app's `writeProfileStore()`
and `loadProfileStore()` are untouched and still fully synchronous.

**Why this matters:** trade screenshots/videos are stored as base64. In a browser they compete for a
~5–10 MB `localStorage` quota (the app's "Reduce stored media" warning). In the file store there is
no quota.

**No automatic browser import (this was previously claimed and was wrong).** Electron runs its own
Chromium profile under the app-data folder; the `localStorage` of Safari/Chrome — where you may have
opened the `.html` directly — is a different origin in a different browser and is unreachable from
here. The old "one-time import" code could never have found it, so it was removed. To move data from
a browser session, copy the `written-profiles-v2` value out of that browser's devtools and into
`written-store.json`.

### Durability

Saves are debounced 250 ms, then written atomically (tmp + rename). Three things make this safe:

- **Failures are never silent.** `bridge.write()` is `ipcRenderer.invoke`, so it returns a *promise*;
  a synchronous `try/catch` cannot catch its rejection. The shim attaches an explicit `.catch`,
  retries, and shows a red banner. This matters because the app's own "could not save" warning is
  unreachable here — it comes from `writeProfileStore()` returning false, but our `setItem` override
  never throws, so the app always believes the save worked.
- **Last-chance flush is synchronous.** `beforeunload` does not fire on force-quit, and an async
  write will not settle during teardown. `flushSync()` uses a sync IPC channel, and the main process
  additionally sends a flush request on `before-quit`.
- **Redundant writes are skipped.** The serialized store is compared to what is already on disk.

Opened directly in a browser (no preload), the shim no-ops and native `localStorage` is used — the
file still works anywhere.

---

## Verification performed

| Check | Result |
|---|---|
| Boots with **zero network requests** (offline vendoring) | ✅ `externalHits: []` |
| React / ReactDOM present from local files | ✅ |
| Runs with **no Babel at all** (verified unused — see below) | ✅ saves ~30 MB RSS + 3.1 MB bundle |
| App renders real UI (`"Written — futures journal … ⌘K … LOCAL"`) | ✅ |
| Native chrome — no fake controls, no stray strip, decorative dots hidden, single 44px header at `top:0` | ✅ both platform paths tested |
| macOS header is draggable while its search input stays clickable | ✅ `drag` / `no-drag` confirmed |
| Minimum window size still clamps to 800×600 | ✅ |
| Store round-trip written and flushed to disk | ✅ |
| **Data survives a full app restart** (fresh process read it back) | ✅ |
| Wrapping never alters the app's logic block (sha256, enforced by the build script) | ✅ |
| In-app Settings → Performance renders, applies, and stays in sync with the menu | ✅ verified both directions |
| Existing logic suite `node --test test/written-v2.logic.test.cjs` | ✅ 123/123 pass |
| Wrapper files present inside the packaged `app.asar` | ✅ |
| **Packaged `.app` boots and writes its own store on first run** | ✅ wrote a valid `{"version":2,…}` profile store |
| Performance Mode reaches 120fps on a 120Hz display | ✅ `reduced`/`max` = 8.3 ms/frame, verified twice each |

Known benign console noise: `<path> attribute d: … "{{nv.icd}}"` etc. — the browser parses the raw
dc-template's mustache placeholders before the runtime processes them. Harmless.

Electron also logs an "Insecure Content-Security-Policy" warning because our CSP must allow
`unsafe-eval`. That is still required **without** Babel: the dc-runtime evaluates the `x-dc` logic
block via `new Function(...)` (`support.js:774`). Removing `unsafe-eval` breaks the app. The warning
disappears in packaged builds.

### Babel is deliberately NOT bundled

`support.js` only loads Babel for `x-import` modules of kind `jsx`. This app has **zero** of those
(its template is HTML and its logic is plain ES6), so Babel was never invoked. Verified empirically:
with the script tag removed the app renders fully and makes no CDN fallback request. Dropping it cut
3.1 MB from the bundle and ~30 MB of resident memory. Do not re-add it unless you start using
`x-import` with JSX.

---

## macOS vs Windows

| Concern | macOS | Windows |
|---|---|---|
| Window controls | **Native traffic lights.** `titleBarStyle:'hiddenInset'` floats them over the page; they land in the left slot of the app's own 44px `.app-titlebar` where the decorative dots used to sit (`trafficLightPosition {x:16,y:15}`). That header is the drag region, with `no-drag` on its input/buttons | **Native system title bar** (`frame:true`). The renderer adds nothing — no strip, no body offset — so there is no double title bar |
| Decorative dots | The template's `.traffic-dot` spans are hidden via `visibility:hidden` in `native-chrome.css` (keeps their space for the real lights) | Same rule hides them — macOS-style dots would be wrong on Windows |
| Close vs quit | Closing does **not** quit (`window-all-closed` skips `app.quit()` on darwin); Dock re-open handled by `activate` | Closing the last window quits |
| Menu | `appMenu` + `editMenu` + `windowMenu` registered so ⌘C/⌘V/⌘Z work | Same menu keeps Ctrl+C/V working |
| Data path | `~/Library/Application Support/Written/` | `%APPDATA%\Written\` |
| Fonts | Self-hosted — identical rendering regardless of installed system fonts | Same |

---

## Possible next steps

- **Extract media to loose files.** Store base64 images as files keyed by hash and keep only paths in
  JSON. Keeps the JSON small and load fast once history grows.
- **Window state persistence** — remember size/position between launches.
- **Signing/notarization** for distribution (macOS notarization; Windows code-signing avoids
  SmartScreen warnings).
