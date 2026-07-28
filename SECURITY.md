# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |

Only the latest 1.0.x release receives fixes.

## Reporting a vulnerability

Please report privately through GitHub, not in a public issue:

**[Report a vulnerability](https://github.com/vurelix/written/security/advisories/new)** — or the
**Security** tab → *Report a vulnerability*.

Useful things to include: the version, your OS, what an attacker gains, and the smallest set of
steps that shows it. A proof-of-concept helps but is not required.

Expect an acknowledgement within about a week. This is a single-maintainer hobby project, so
please don't expect a same-day response. You'll be credited in the advisory unless you'd rather
not be.

## What this project's threat model actually is

Written is local-first and deliberately has no network surface: no account, no server, no
telemetry, no auto-update. It makes **zero** network requests at boot — React, ReactDOM and its
fonts are vendored, and the build refuses to ship if any remote reference survives. So the usual
web attack surface mostly does not exist here.

What matters instead:

- **Renderer isolation.** `contextIsolation: true`, `nodeIntegration: false`. The renderer reaches
  the filesystem only through four named IPC channels defined in `desktop/ipc-channels.js`.
- **CSP.** Enforced via `<meta>`, injected by `desktop/scripts/build-renderer.js`. It allows
  `unsafe-eval` because the dc-runtime evaluates the app's logic block through `new Function(...)`.
  Removing it breaks the app. A CSP bypass that escapes the renderer is in scope.
- **File handling.** Trade screenshots and clips are user-supplied and stored base64-inline. Anything
  that turns opening a journal into code execution is in scope.

### Known and accepted

These are documented trade-offs, not vulnerabilities — please don't report them as such:

- **Your journal is not encrypted at rest.** `written-store.json` is plain JSON in your app-data
  folder. Anyone with access to your user account can read it. The optional profile password gates
  the UI only; it is not a decryption key and is not claimed to be one.
- **Builds are ad-hoc signed, not notarized.** macOS and Windows both warn on first launch. This is
  expected for a self-distributed app and is called out in the README.
- **`unsafe-eval` is required**, as above.

## Scope

In scope: this repository, and the macOS and Windows builds published under
[Releases](https://github.com/vurelix/written/releases).

Out of scope: anything requiring prior local access to an already-unlocked account, social
engineering, and vulnerabilities in Electron or Chromium themselves — report those upstream, though
do tell us if a version bump here would fix one.
