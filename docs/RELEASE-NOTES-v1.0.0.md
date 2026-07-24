# 📓 Written 1.0.0

**The first official release.** A private futures trading journal that runs entirely on your own
machine — no account, no server, no telemetry. Your trades never leave your computer.

macOS and Windows builds are attached below. 🎉

---

## ✨ What's in it

| | |
|---|---|
| 📊 **Dashboard** | Equity curve, win rate, drawdown, streaks — your edge at a glance |
| 🗓️ **Calendar** | Every trading day colour-coded by P&L |
| 📋 **Trades** | Full execution table: entry, stop, target, exit, R, hold time |
| 🖼️ **Gallery** | Chart screenshots with drawable annotations |
| 📈 **Insights** | Time-of-day edge, tag performance, mistake tracking, tilt radar |
| 📕 **Playbook** | Your setups, written down and kept honest |
| 👥 **Profiles** | Multiple journals, switchable, all stored locally |
| 🧮 **Risk sizing** | Position sizing from account balance, risk % and stop distance |

---

## 📥 Install

### 🍎 macOS

| Your Mac | Download |
|---|---|
| 🚀 Apple Silicon (M1–M4) | `Written-1.0.0-arm64.dmg` |
| 💻 Intel | `Written-1.0.0.dmg` |

Open the `.dmg`, drag **Written** into **Applications**, and launch it.

The build is ad-hoc signed but **not notarized**, so macOS may refuse it the first time. If you see
*"cannot be opened"* or *"is damaged"*, clear the download quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Written.app
```

### 🪟 Windows

Download **`Written Setup 1.0.0.exe`** and run it. SmartScreen will warn because the installer is
unsigned — click **More info → Run anyway**, then choose your install folder.

One installer covers both **x64** and **ARM64**.

---

## 💾 Your data

Everything lives in one JSON file, written atomically:

```
🍎 macOS    ~/Library/Application Support/Written/written-store.json
🪟 Windows  %APPDATA%\Written\written-store.json
```

**That file is your whole journal, so it's also your backup.** Copy it to keep a snapshot, or drop it
into the same path on another machine to bring your history across. It sits outside the app bundle,
so reinstalling or updating never touches it.

Screenshots are stored inline in that file. In a browser they'd blow past the ~5–10 MB `localStorage`
quota; here there's no such limit.

---

## ⚡ Performance Mode

Written layers ~18 frosted-glass panels over animated background glows. On a 120 Hz display that's
more than the GPU can re-blur every frame, so there's a switch for it in **Settings → Performance**
or **View → Performance Mode** (`⌘⌥1` / `⌘⌥2` / `⌘⌥3`):

| Mode | Frame time | FPS | Frosted glass |
|---|---|---|---|
| 🎨 Full effects | 13–32 ms | 31–73 | ✅ |
| ⚖️ **Reduced motion** *(default)* | **8.3 ms** | **120** | ✅ kept |
| 🚀 Maximum performance | **8.3 ms** | **120** | ❌ |

**Reduced motion** ships as the default because it hits a locked 120 fps *while keeping every glass
panel* — you only lose the perpetual background drift. Both switches drive the same setting.

---

## 🔒 Privacy & offline

- **No network calls.** React, ReactDOM and the fonts are bundled locally — the app makes zero
  requests at startup. Verified, not assumed.
- **No account, no server, no telemetry.** Nothing is uploaded, ever.
- Hardened renderer: `contextIsolation` on, `nodeIntegration` off, CSP enforced, and filesystem
  access only through a handful of named IPC channels.

---

## ⚠️ Known limitations

- **Unsigned builds.** Both platforms warn on first launch (see install steps). Code signing and
  notarization are planned.
- **Windows is untested on real hardware.** It builds and packages correctly from macOS, but this
  release has not been run on a physical Windows machine. Please open an issue if it misbehaves.
- **No auto-update.** Future versions must be downloaded manually.
- **Screenshots live in the JSON store**, so the file grows with heavy image use. Moving media to
  separate files is on the roadmap.
- **Manual backups only.** Export/import is planned; for now, copy `written-store.json`.

---

## 🔐 Verify your download

```
Written-1.0.0-arm64.dmg    f07c18def21f889800a127ff109ce66fb4e363ee67c707a2204ac5f1c451412c
Written-1.0.0.dmg          f6611e61fa6ae4c3c5cc03a1e467b3a074617818104a11fbc86c70de69b0c3ab
Written Setup 1.0.0.exe    d016c28c61a96e0f90abe1be25e09cc1a54bf1ff236a90db624b53a35b5b1434
```

```bash
shasum -a 256 Written-1.0.0-arm64.dmg     # macOS
certutil -hashfile "Written Setup 1.0.0.exe" SHA256   # Windows
```

---

## 🛠️ Under the hood

Written is a React 18 single-page app on an in-house `dc-runtime`, wrapped in Electron 31. The
desktop layer wraps *around* the app rather than rewriting it: `scripts/build-renderer.js`
regenerates the renderer from the app source and refuses to build if wrapping altered the app's logic
block. 123 logic tests cover the journal behaviour.

Licensed **MIT**. Bundled components keep their own terms — React & ReactDOM and Electron (MIT), and
the Manrope typeface (SIL OFL 1.1) — all reproduced in full under **About → Open Source**.

---

<div align="center">

**Built for traders who'd rather own their data.** 📈

</div>
