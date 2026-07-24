/*
 * perf.js — applies the current Performance Mode.
 *
 * Loaded in <head> BEFORE support.js so the mode is set before the first paint
 * (no flash of the heavy state on startup). The actual rules live in perf.css.
 *
 * Mode is owned by the main process (View → Performance Mode) and persisted to
 * desktop-prefs.json in the app-data folder.
 */
(() => {
  // Both the valid list and the fallback come from the shared IPC contract
  // (ipc-channels.js) via preload, so they cannot drift from the main process.
  const prefsApi = window.desktopPrefs || {};
  const VALID = prefsApi.validModes || ['full', 'reduced', 'max'];
  const FALLBACK = prefsApi.defaultMode || 'reduced';

  const apply = (mode) => {
    const m = VALID.includes(mode) ? mode : FALLBACK;
    document.documentElement.setAttribute('data-perf', m);
  };

  // Initial value, read synchronously so it is in place before the app renders.
  let initial = FALLBACK;
  try {
    if (typeof prefsApi.getPerfMode === 'function') initial = prefsApi.getPerfMode();
  } catch (_e) { /* keep FALLBACK */ }
  apply(initial);

  // Live updates when the menu item changes.
  if (typeof prefsApi.onPerfMode === 'function') prefsApi.onPerfMode(apply);
})();
