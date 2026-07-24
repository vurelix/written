/*
 * native-chrome.js — native window chrome support.
 *
 * There are no custom window controls. The OS draws them:
 *   macOS   -> real traffic lights (main.js: titleBarStyle:'hiddenInset'), which float
 *              over the app's own `.app-titlebar` header where the decorative dots were
 *   Windows -> the standard system title bar (main.js: frame:true)
 *
 * All the actual work is CSS (native-chrome.css). This script only tags the document so the
 * macOS-specific rules apply. It injects no elements and reserves no space, so the app's
 * own header remains the one and only title bar.
 *
 * Runs at the end of <body>, which executes before DOMContentLoaded and therefore before
 * the dc-runtime mounts React — so the class is set before the first paint.
 */
(() => {
  if (window.desktopPlatform === 'darwin') {
    document.documentElement.classList.add('dc-mac');
  }
})();
