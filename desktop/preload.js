'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const CH = require('./ipc-channels');

// Window controls are native (macOS traffic lights / Windows system buttons), so the
// renderer only needs to know the platform in order to reserve traffic-light space.
contextBridge.exposeInMainWorld('desktopPlatform', process.platform);

// Opens the bundled THIRD-PARTY-LICENSES.txt in the OS default text viewer.
contextBridge.exposeInMainWorld('desktopApp', {
  openLicenses: () => ipcRenderer.send(CH.APP_OPEN_LICENSES)
});

// Desktop preferences. getPerfMode() is synchronous so perf.js can apply the mode
// before first paint; onPerfMode fires when the View menu changes it.
// `defaultMode` is forwarded from the shared contract so the renderer's fallback
// cannot drift from the main process's default.
contextBridge.exposeInMainWorld('desktopPrefs', {
  defaultMode: CH.DEFAULT_PERF,
  validModes: CH.PERF_MODES.slice(),
  getPerfMode: () => ipcRenderer.sendSync(CH.PREFS_READ_SYNC),
  setPerfMode: (mode) => ipcRenderer.send(CH.PREFS_SET_MODE, mode),
  onPerfMode: (cb) => ipcRenderer.on(CH.PREFS_PERF_MODE, (_e, mode) => cb(mode))
});

// File-backed storage bridge used by store-shim.js.
//   readSync()   -> whole store as a JSON string (sync, once on boot)
//   write(json)  -> persist (async). REJECTS on failure — the caller must handle it,
//                   otherwise a failed save is silent data loss.
//   writeSync()  -> last-chance flush; returns boolean, never throws across IPC.
//   onFlushRequest(cb) -> main asks us to flush synchronously before quitting.
contextBridge.exposeInMainWorld('desktopStore', {
  readSync: () => ipcRenderer.sendSync(CH.STORE_READ_SYNC),
  write: (json) => ipcRenderer.invoke(CH.STORE_WRITE, json),
  writeSync: (json) => ipcRenderer.sendSync(CH.STORE_WRITE_SYNC, json),
  onFlushRequest: (cb) => ipcRenderer.on(CH.STORE_FLUSH_REQUEST, () => cb())
});
