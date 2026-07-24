/*
 * afterPack hook — ad-hoc code-sign the macOS bundle.
 *
 * Without this, electron-builder ships the app unsigned: it keeps Electron's original
 * linker-signed stub, which no longer matches our modified bundle. `codesign --verify`
 * then fails with "code has no resources but signature indicates they must be present",
 * and macOS refuses to launch the app, reporting it as malware.
 *
 * Ad-hoc signing (`--sign -`) produces a valid signature with no certificate, which is
 * enough for the app to run locally and is REQUIRED on Apple Silicon, where arm64
 * binaries must carry a valid signature to execute at all.
 *
 * This is NOT a substitute for a Developer ID + notarization when distributing to others.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`  • ad-hoc signing  ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc signature verified');
};
