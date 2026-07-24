'use strict';

/*
 * Single source of truth for IPC channel names, shared by main.js and preload.js.
 *
 * Why this file exists: these names used to be string literals duplicated across the
 * process boundary. A mismatch fails SILENTLY — `ipcRenderer.sendSync` on a channel with
 * no listener returns `undefined` and only logs a console warning, so the renderer sees a
 * plausible-looking value and carries on. That exact bug cost real debugging time.
 *
 * Required by both processes, so it must stay dependency-free and CommonJS.
 */
module.exports = {
  // Desktop preferences
  PREFS_READ_SYNC: 'prefs:read-sync',   // renderer -> main (sync)  : current perf mode
  PREFS_PERF_MODE: 'prefs:perf-mode',   // main -> renderer (push)  : mode changed
  PREFS_SET_MODE:  'prefs:set-mode',    // renderer -> main (async) : in-app Settings changed it

  // Journal store
  STORE_READ_SYNC: 'store:read-sync',   // renderer -> main (sync)  : whole store as JSON
  STORE_WRITE: 'store:write',           // renderer -> main (async) : persist whole store
  STORE_WRITE_SYNC: 'store:write-sync', // renderer -> main (sync)  : last-chance flush
  STORE_FLUSH_REQUEST: 'store:flush',   // main -> renderer (push)  : flush before quit

  // Performance-mode values, shared so the renderer default cannot drift from main's.
  PERF_MODES: ['full', 'reduced', 'max'],
  DEFAULT_PERF: 'reduced'
};
