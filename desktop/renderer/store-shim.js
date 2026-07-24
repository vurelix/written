/*
 * store-shim.js — MUST run before support.js.
 *
 * Redirects the app's three journal storage keys from the browser's quota-limited
 * localStorage to a file-backed store in the OS app-data folder (via preload/IPC).
 * The app keeps calling localStorage.getItem/setItem synchronously and unmodified —
 * writeProfileStore()/loadProfileStore() in the app are untouched.
 *
 * Base64 screenshots/videos now land in a real file with no ~5-10MB quota.
 *
 * If window.desktopStore is absent (the .html opened in a plain browser), this shim
 * no-ops and native localStorage is used, so the file still works anywhere.
 *
 * ---------------------------------------------------------------------------
 * Durability notes (these were real bugs, do not "simplify" them away):
 *
 *  1. `bridge.write()` is ipcRenderer.invoke -> it returns a PROMISE. A synchronous
 *     try/catch cannot catch its rejection. Without an explicit .catch, a failed disk
 *     write (full disk, permissions) loses journal data silently.
 *
 *  2. The app's own "could not save" warning is unreachable here. It comes from
 *     writeProfileStore() returning false, but our setItem override never throws, so
 *     the app always believes the save succeeded. We therefore surface failures
 *     ourselves via a visible banner — otherwise nothing tells the user.
 *
 *  3. A debounce plus `beforeunload` is not enough: beforeunload does not fire on
 *     force-quit, and an async write will not settle during teardown. The last-chance
 *     flush is SYNCHRONOUS, and the main process also asks us to flush before quitting.
 * ---------------------------------------------------------------------------
 */
(() => {
  const bridge = window.desktopStore;
  if (!bridge) return; // plain browser — native localStorage

  // Load-order guard. If the dc-runtime already booted, our overrides are too late and
  // the app would silently use real localStorage (re-introducing the quota bug).
  if (window.DCLogic || window.__dcRegistry) {
    console.error('[store-shim] loaded AFTER support.js — journal persistence is NOT active. ' +
                  'store-shim.js must appear before support.js in index.html.');
  }

  const KEYS = new Set([
    'written-profiles-v2', // PK — current multi-profile store
    'written-settings-v1', // SK — legacy settings
    'written-data-v1'      // K  — legacy days
  ]);

  const DEBOUNCE_MS = 250;

  // Hydrate the in-memory cache once, synchronously, from disk.
  let cache = {};
  try {
    cache = JSON.parse(bridge.readSync() || '{}') || {};
  } catch (err) {
    console.error('[store-shim] could not parse the store file; starting empty:', err);
    cache = {};
  }

  const origGet = localStorage.getItem.bind(localStorage);
  const origSet = localStorage.setItem.bind(localStorage);
  const origRemove = localStorage.removeItem.bind(localStorage);
  const origClear = localStorage.clear.bind(localStorage);

  let timer = null;
  let lastWritten = JSON.stringify(cache); // what is currently on disk
  let inFlight = false;
  let failed = false;

  // --- Visible failure reporting -------------------------------------------------
  let banner = null;
  function showFailure(err) {
    failed = true;
    console.error('[store-shim] SAVE FAILED — journal changes are not on disk:', err);
    if (banner || !document.body) return;
    banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'background:#7f1d1d', 'color:#fff', 'padding:10px 14px',
      'font:12px/1.4 Manrope,system-ui,sans-serif', 'text-align:center'
    ].join(';');
    banner.textContent = 'Could not save your journal to disk. Recent changes are unsaved — ' +
                         'check free disk space and permissions.';
    document.body.appendChild(banner);
  }
  function clearFailure() {
    failed = false;
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  // --- Writing -------------------------------------------------------------------
  function flushAsync() {
    timer = null;
    if (inFlight) { scheduleFlush(); return; } // coalesce; retry after the current write
    const json = JSON.stringify(cache);
    if (json === lastWritten) return;          // nothing changed — skip the write entirely
    inFlight = true;
    bridge.write(json)
      .then(() => { inFlight = false; lastWritten = json; if (failed) clearFailure(); })
      .catch((err) => {
        inFlight = false;
        showFailure(err);
        scheduleFlush(); // keep retrying; lastWritten is unchanged so it will try again
      });
  }

  function scheduleFlush() {
    if (!timer) timer = setTimeout(flushAsync, DEBOUNCE_MS);
  }

  // Last-chance synchronous flush: used on quit/hide, where a promise would not settle.
  function flushSync() {
    if (timer) { clearTimeout(timer); timer = null; }
    const json = JSON.stringify(cache);
    if (json === lastWritten) return true;
    try {
      const ok = bridge.writeSync(json);
      if (ok) { lastWritten = json; return true; }
      showFailure(new Error('synchronous write rejected by main process'));
      return false;
    } catch (err) {
      showFailure(err);
      return false;
    }
  }

  // --- localStorage overrides (only for our three keys) ---------------------------
  localStorage.getItem = (k) =>
    KEYS.has(k) ? (k in cache ? cache[k] : null) : origGet(k);

  localStorage.setItem = (k, v) => {
    if (KEYS.has(k)) { cache[k] = String(v); scheduleFlush(); }
    else origSet(k, v);
  };

  localStorage.removeItem = (k) => {
    if (KEYS.has(k)) { delete cache[k]; scheduleFlush(); }
    else origRemove(k);
  };

  // clear() must also clear our keys, or the app would "reset" while the file store
  // silently kept the old journal and restored it on next launch.
  localStorage.clear = () => {
    cache = {};
    scheduleFlush();
    origClear();
  };

  // --- Flush triggers -------------------------------------------------------------
  window.addEventListener('beforeunload', flushSync);
  // Covers Cmd+Q / app.quit(), where beforeunload is not reliable.
  if (typeof bridge.onFlushRequest === 'function') bridge.onFlushRequest(flushSync);
  // Cheap insurance when the window is hidden or loses focus.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSync();
  });
  window.addEventListener('blur', () => { if (timer) flushSync(); });
})();
