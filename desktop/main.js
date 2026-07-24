'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const CH = require('./ipc-channels');

// Pin the app name so the data folder is "Written" in both dev and packaged builds
// (otherwise dev runs land under a folder named "Electron").
app.setName('Written');

// Single JSON store in the OS per-user app-data directory.
//   macOS   -> ~/Library/Application Support/Written/written-store.json
//   Windows -> %APPDATA%\Written\written-store.json
const STORE_FILE = () => path.join(app.getPath('userData'), 'written-store.json');

// Desktop-only preferences, kept separate from the user's journal data.
const PREFS_FILE = () => path.join(app.getPath('userData'), 'desktop-prefs.json');

let prefs = { perfMode: CH.DEFAULT_PERF };
let mainWindow = null;
let quitFlushDone = false;

const isMac = process.platform === 'darwin';

function readPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
    if (!CH.PERF_MODES.includes(p.perfMode)) p.perfMode = CH.DEFAULT_PERF;
    return p;
  } catch (_e) {
    return { perfMode: CH.DEFAULT_PERF };
  }
}

function writePrefs(next) {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(next), 'utf8');
  } catch (err) {
    console.error('[written] could not save desktop prefs:', err.message);
  }
}

// Atomic write (tmp + rename) so a crash mid-write cannot corrupt the store.
// Throws on failure — callers must surface it; silent failure loses journal data.
function writeStoreSync(json) {
  const target = STORE_FILE();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, target);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800, // required minimums
    minHeight: 600,
    backgroundColor: '#0B0E13', // matches the app --bg so there is no white flash
    show: false, // wait for ready-to-show to avoid a blank flash
    // Native window chrome on both platforms:
    //   macOS   -> hidden title bar; the real traffic lights float over the app's own
    //              44px `.app-titlebar`, aligned to where its decorative dots sat
    //   Windows -> the standard system title bar and controls
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
      : { frame: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false,
      sandbox: false, // preload bridges fs via IPC; keep sandbox off, isolation on
      spellcheck: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in the user's real browser, never a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- Menu: standard app/Edit/Window roles, plus View -> Performance Mode.
function setPerfMode(mode) {
  if (!CH.PERF_MODES.includes(mode)) return;
  prefs.perfMode = mode;
  writePrefs(prefs);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CH.PREFS_PERF_MODE, mode);
  }
}

function buildMenu() {
  const perfItem = (label, mode, accel) => ({
    label, accelerator: accel, type: 'radio',
    checked: prefs.perfMode === mode,
    click: () => setPerfMode(mode)
  });

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Performance Mode',
          submenu: [
            // Measured on a 120Hz display: full ~31-73fps, reduced/max a locked 120fps.
            perfItem('Full effects', 'full', 'CommandOrControl+Alt+1'),
            perfItem('Reduced motion (keeps glass)', 'reduced', 'CommandOrControl+Alt+2'),
            perfItem('Maximum performance', 'max', 'CommandOrControl+Alt+3')
          ]
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Window controls are handled natively by the OS — no custom IPC needed.

// --- Desktop prefs IPC (read synchronously at boot so there is no visual flash) ---
ipcMain.on(CH.PREFS_READ_SYNC, (e) => { e.returnValue = prefs.perfMode; });

// The Settings tab in the app can change the mode too. Rebuild the menu so its radio
// reflects the new value — the menu and the in-app control are one setting, not two.
ipcMain.on(CH.PREFS_SET_MODE, (_e, mode) => {
  if (!CH.PERF_MODES.includes(mode) || mode === prefs.perfMode) return;
  setPerfMode(mode);
  buildMenu();
});

// Open the bundled third-party licenses. Packaged builds place it in Resources via
// `extraResources`; in dev it sits next to package.json.
ipcMain.on(CH.APP_OPEN_LICENSES, () => {
  const packaged = path.join(process.resourcesPath || '', 'THIRD-PARTY-LICENSES.txt');
  const dev = path.join(__dirname, 'THIRD-PARTY-LICENSES.txt');
  const target = fs.existsSync(packaged) ? packaged : dev;
  if (fs.existsSync(target)) shell.openPath(target);
  else console.error('[written] THIRD-PARTY-LICENSES.txt not found');
});

// --- Journal store IPC ---
ipcMain.on(CH.STORE_READ_SYNC, (e) => {
  try {
    e.returnValue = fs.readFileSync(STORE_FILE(), 'utf8');
  } catch (_err) {
    e.returnValue = '{}'; // first run / missing file
  }
});

// Async path (normal debounced saves). Rejects on failure so the renderer can report it.
ipcMain.handle(CH.STORE_WRITE, async (_e, json) => {
  const target = STORE_FILE();
  const tmp = target + '.tmp';
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(tmp, json, 'utf8');
  await fs.promises.rename(tmp, target);
  return true;
});

// Sync path — last-chance flush on beforeunload/quit, where a promise would not
// settle before teardown. Returns false rather than throwing across the boundary.
ipcMain.on(CH.STORE_WRITE_SYNC, (e, json) => {
  try { writeStoreSync(json); e.returnValue = true; }
  catch (err) {
    console.error('[written] synchronous store write failed:', err.message);
    e.returnValue = false;
  }
});

// Give the renderer a chance to flush pending edits before the app exits.
// `beforeunload` alone is not reliable for Cmd+Q / app.quit().
app.on('before-quit', (event) => {
  if (quitFlushDone || !mainWindow || mainWindow.isDestroyed()) return;
  event.preventDefault();
  quitFlushDone = true;
  mainWindow.webContents.send(CH.STORE_FLUSH_REQUEST);
  // The renderer flushes synchronously; give it a brief window, then really quit.
  setTimeout(() => app.quit(), 150);
});

app.whenReady().then(() => {
  prefs = readPrefs();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS keeps the app alive when all windows close; other platforms quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
