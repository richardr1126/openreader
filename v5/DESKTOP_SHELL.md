# V5 Desktop Shell

Status: prototype, 2026-10-14. `desktop/` builds and runs on macOS arm64
(staged runtime, `electron .`, and a signed DMG); Windows and Linux packaging is
written but not yet built. Companion to `v5/DESKTOP_SINGLE_OWNER.md`, which
owns the auth boundary and the profile.

## Decision

The desktop app is an Electron shell (electron-builder) around the same slim
runtime the Docker image runs: the standalone Next.js app, the bootstrap
supervisor, the embedded worker, nats-server, SeaweedFS and SQLite. There is no
Docker and no separate install step. The shell adds no server code: it starts
the runtime, signs the owner in, and shows one window.

`desktop/` is its own pnpm project (like `docs-site/`), outside the root
workspace, so Electron and electron-builder never enter the app's dependency
graph or lockfile.

## Layout

```
desktop/
  runtime-binaries.json  nats-server and weed per target, pinned by SHA-256
  scripts/stage.mjs      assembles stage/runtime for this machine
  scripts/package.mjs    electron-builder for this machine
  src/main.mjs           window, owner sign-in, navigation policy, quit
  src/runtime.mjs        ports, environment, spawn/stop, readiness
  src/loading.html       shown while the runtime starts
```

The staged runtime mirrors the Docker image:

| Path | Contents |
|---|---|
| `node/` | the official Node.js binary (the version that ran staging) and its LICENSE |
| `app/` | `.next/standalone` plus `.next/static` and `public`, with `.env*` removed |
| `bootstrap/` | `pnpm deploy` of `@openreader/bootstrap`, `better-sqlite3` rebuilt |
| `embedded-compute-worker/` | `pnpm deploy --prod` of the worker |
| `bin/` | nats-server and weed from `runtime-binaries.json` |
| `ffmpeg/` | the LGPL build from `packaging/ffmpeg` |
| `licenses/` | NATS and SeaweedFS licence texts |

It ships as an `extraResources` directory (`Resources/runtime`), outside the
asar, because it runs as ordinary processes. Native modules come from the
checkout's install and the bundled Node.js is the version that staged it, so
every target is staged and packaged on its own platform and architecture.

## Runtime supervision

`src/runtime.mjs` spawns `node bootstrap/src/cli.mjs -- node app/server.js`,
the same command as the Docker entrypoint.

- **Environment.** Built from an allowlist (home, temp, locale and Windows
  system variables), never the user's whole environment, so a developer's
  OpenReader settings cannot leak in. On top: `AUTH_SECRET`,
  `DESKTOP_LAUNCH_TOKEN`, `BASE_URL`, `HOSTNAME=127.0.0.1`, `PORT`, the embedded
  service ports, `USE_EMBEDDED_WEED_MINI=true`, `FFMPEG_BIN`, `LOG_FORMAT=json`,
  and `IMPORT_LIBRARY_DIRS`. No new variables.
- **Ports.** The app, worker, NATS, NATS monitor and SeaweedFS S3 ports are
  chosen free on 127.0.0.1 at each launch.
- **Data.** The working directory and `PWD` are the userData directory, so the
  bootstrap and worker put SQLite, SeaweedFS, JetStream and models in
  `<userData>/docstore`, as they would beside a checkout. The local library
  defaults to `<userData>/docstore/library` through `IMPORT_LIBRARY_DIRS`,
  because the standalone server runs from the read-only bundle.
- **Secrets.** `AUTH_SECRET` is generated once into `<userData>/auth-secret`
  (mode 0600); the playback secret derives from it as on any embedded install.
  The launch token is new on every launch and lives only in memory and the
  app's environment.
- **Logs.** Bootstrap output goes to `<logs>/runtime.log`, rotated once at
  10 MB.
- **Readiness.** The window shows `loading.html` until `/api/auth/ok` answers.
- **Stopping.** The shell owns an IPC channel to bootstrap and disconnects it on
  quit; bootstrap treats that as SIGTERM and stops every service (this works on
  Windows, where there are no signals, and the channel also closes if the shell
  dies). The shell kills bootstrap after 15 seconds if it has not exited. If the
  runtime stops by itself, the shell shows the log path and quits.

## Window and navigation

- One window, single-instance lock; a second launch focuses it.
- Owner sign-in runs in the main process: `POST /api/auth/desktop/session`
  with the bearer token and a JSON body, then each `Set-Cookie` goes into the
  default session with `session.cookies.set`. The window then loads `/app`.
- A navigation, redirect or client-side route change to `/signin` repeats the
  exchange and reloads `/app`.
- Pages outside the app origin open in the system browser (`http`, `https` and
  `mailto` only); new windows on the app origin are allowed.
- The renderer runs with context isolation and the sandbox, no Node.js
  integration and no preload yet.

## Packaging

`pnpm --dir desktop package` builds for the host: a DMG on macOS, an NSIS
installer on Windows, an AppImage and a `.deb` on Linux. The version is the root
package version. On macOS electron-builder signs every Mach-O in the bundle with
the hardened runtime and Electron's JIT entitlements, which the bundled Node.js
needs; a local build uses whatever identity is in the keychain.

## Building

```bash
pnpm build
pnpm --dir desktop install
pnpm --dir desktop stage
pnpm --dir desktop start
pnpm --dir desktop package
```

`stage` fetches the pinned ffmpeg. Until `packaging/ffmpeg/manifest.json` has
SHAs, pass `--ffmpeg-dir <dir>` with a local build laid out like `fetch.mjs`
output.

## Not done yet

- **CI.** A workflow that stages and packages on macos-15, macos-15-intel,
  windows-2025, windows-11-arm, ubuntu-24.04 and ubuntu-24.04-arm, pinning
  Node.js 24.
- **Signing and updates.** Notarization, Windows code signing and an update
  channel.
- **SeaweedFS admin gRPC.** Bootstrap now keeps each of `weed mini`'s internal
  ports (persisted, else mini's default) unless it is taken, and turns off
  WebDAV, Iceberg and the admin UI. The admin server itself cannot be disabled
  and ignores `-ip.bind`: its HTTP port serves only health and metrics, but its
  gRPC port still listens on every interface. Worth an upstream issue.
- **DOCX.** Conversion needs `soffice`, which desktop does not bundle.
- **Size.** About 400 MB on macOS arm64, 280 MB of it `onnxruntime-node`
  binaries for every platform; pruning to the target platform is the obvious
  first cut.
- **Worker data path in a checkout.** The worker prefers a `pnpm-workspace.yaml`
  above its working directory for `docstore/`, so a runtime run from inside the
  repository (`desktop/stage` or `desktop/dist`) keeps models in the checkout's
  `docstore/`. Installed apps are unaffected.
- **Preload bridge, file associations, menus, and the Local voices card**
  (`v5/DESKTOP_SINGLE_OWNER.md`).
