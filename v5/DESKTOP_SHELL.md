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
  scripts/smoke.mjs      starts the staged runtime headless and checks sign-in
  src/main.mjs           window, cookie store, navigation policy, bridge, quit
  src/preload.cjs        the page's bridge into the shell
  src/open-documents.mjs reads opened documents and hands them to the library
  src/menu.mjs           the application menu
  src/runtime.mjs        ports, environment, spawn/stop, readiness, token exchange
  src/loading.html       shown while the runtime starts
```

The staged runtime mirrors the Docker image:

| Path | Contents |
|---|---|
| `node/` | the official Node.js binary (the version that ran staging) and its LICENSE |
| `app/` | `.next/standalone` plus `.next/static` and `public`, with `.env*` removed |
| `bootstrap/` | `pnpm deploy` of `@openreader/bootstrap`, `better-sqlite3` rebuilt |
| `embedded-compute-worker/` | `pnpm deploy --prod` of the worker, `onnxruntime-node` binaries pruned to the target |
| `bin/` | nats-server and weed from `runtime-binaries.json` |
| `ffmpeg/` | the LGPL build from `packaging/ffmpeg` |
| `licenses/` | NATS and SeaweedFS licence texts |

It ships as an `extraResources` directory (`Resources/runtime`), outside the
asar, because it runs as ordinary processes. Native modules come from the
checkout's install and the bundled Node.js is the version that staged it, so
every target is staged and packaged on its own platform and architecture.

## Runtime supervision

`src/runtime.mjs` spawns `node bootstrap/src/cli.mjs -- node app/server.js`,
the same command as the Docker entrypoint. It is plain Node.js with no Electron
import, so the smoke test runs the shell's own startup and sign-in code.

- **Environment.** Built from an allowlist (home, temp, locale and Windows
  system variables), never the user's whole environment, so a developer's
  OpenReader settings cannot leak in. `PATH` gains `runtime/bin` in front and
  LibreOffice's install folder at the end when present (see DOCX below). On top: `AUTH_SECRET`,
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
- The renderer runs with context isolation and the sandbox and no Node.js
  integration.
- There is no system title bar. The window uses `titleBarStyle: 'hidden'` with
  the Window Controls Overlay, so the app's own top bar (`AppHeader` and
  `Toolbar`, both marked `.titlebar` in `globals.css`) is the title bar. The
  traffic lights (macOS) or the minimize/maximize/close buttons (Windows and
  Linux) sit inside it. `.titlebar` pads itself with `env(titlebar-area-*)` to
  clear the controls and is a drag region whose controls opt out; pages without
  a top bar keep a drag strip from `body::before`. Outside the desktop shell the
  env values are unset and the rule changes nothing.
- On Windows and Linux the shell draws the controls, so the page reports the
  theme's `--base` and `--foreground` through `setTitleBarColors` whenever the
  theme changes (`DesktopTitleBarColors`); macOS draws its own.

## Bridge, menu and opened documents

`preload.cjs` exposes `window.openreaderDesktop` with four fixed actions:
`onOpenFiles(callback)`, `setTitleBarColors(colors)`, `revealDataFolder()` and
`openLogsFolder()`. The page never passes a path (the shell accepts only two hex
colours for the title bar), and the main process ignores bridge calls from any frame
outside the app origin. The UI treats the bridge as a capability
(`useDesktopBridge()` in `src/hooks`). Settings → Library and storage offers
"Show data folder" and Maintenance offers "Open logs folder" only when the bridge
has them.

Documents reach the library one way, whatever opened them:

- **File → Open…** (Ctrl/Cmd+O) shows a native dialog filtered to PDF, EPUB,
  TXT, Markdown and DOCX.
- **File associations.** The package claims `.epub` and offers itself for
  `.pdf` (macOS rank Alternate). macOS delivers `open-file` events, which can
  arrive before the window exists. Windows and Linux pass paths on the command
  line, and the single-instance lock forwards a second launch's paths.
- Drag and drop from the file manager needs nothing: the library's dropzone
  already accepts it.

`DocumentInbox` reads each file and queues it until a library page listens.
`DesktopDocumentOpener`, mounted in the `/app` layout inside `DocumentProvider`,
registers through the bridge and calls `uploadDocuments`, the same flow as a
drop. If no library page is listening (a reader is open, say), the shell loads
`/app` first. One opened document then opens in its reader; several land in the
library. A full page load drops the listener, and the inbox notices through
`did-navigate`.

The menu adds Open…, Settings (Ctrl/Cmd+,, which loads `/app/settings`), and
Help (documentation, logs folder) to the standard roles. DevTools appear only
when unpackaged. Play and pause stay with the page's own keys and media keys
(`mediaSession`).

## Packaging

`pnpm --dir desktop package` builds for the host: a DMG on macOS, an NSIS
installer on Windows, an AppImage and a `.deb` on Linux. The version is the root
package version. On macOS electron-builder signs every Mach-O in the bundle with
the hardened runtime and Electron's JIT entitlements, which the bundled Node.js
needs; a local build uses whatever identity is in the keychain.

## CI

`.github/workflows/desktop.yml` runs on pull requests that touch `desktop/`,
`packaging/` or `packages/bootstrap/`, and on demand. Each of macos-15,
macos-15-intel, windows-2025, windows-11-arm, ubuntu-24.04 and ubuntu-24.04-arm
builds the app with Node.js 24.21.0, stages, runs `pnpm --dir desktop smoke`,
packages unsigned and uploads the installers for seven days.

The smoke test starts the staged runtime in temporary directories and checks
that a wrong launch token gets 401, the real one returns an HttpOnly session for
the admin owner, `/app` loads without a redirect, the runtime runs until
stopped, and the token never reaches the log. It needs no TTS provider and does
not open a window.

Staging fetches the pinned ffmpeg, so the workflow cannot pass until
`packaging/ffmpeg/manifest.json` has SHAs.

## Building

```bash
pnpm build
pnpm --dir desktop install
pnpm --dir desktop stage
pnpm --dir desktop smoke
pnpm --dir desktop start
pnpm --dir desktop package
```

`stage` fetches the pinned ffmpeg. Until `packaging/ffmpeg/manifest.json` has
SHAs, pass `--ffmpeg-dir <dir>` with a local build laid out like `fetch.mjs`
output.

## Not done yet

- **Windows and Linux builds.** The workflow is written but has not run yet.
- **Signing and updates.** Notarization, Windows code signing and an update
  channel.
- **SeaweedFS admin gRPC.** Bootstrap now keeps each of `weed mini`'s internal
  ports (persisted, else mini's default) unless it is taken, and turns off
  WebDAV, Iceberg and the admin UI. The admin server itself cannot be disabled
  and ignores `-ip.bind`: its HTTP port serves only health and metrics, but its
  gRPC port still listens on every interface. Worth an upstream issue.
- **DOCX.** Conversion needs LibreOffice, which desktop does not bundle (it is
  several hundred MB and MPL-licensed). The shell appends LibreOffice's standard
  install folders to the runtime's `PATH` (`/Applications` and
  `~/Applications/LibreOffice.app/Contents/MacOS`, `%ProgramFiles%\LibreOffice\program`),
  because apps opened from the Dock or Start menu do not inherit a shell `PATH`.
  Without it, the upload reports that LibreOffice is not installed. The upload
  dialog still offers DOCX either way.
- **Size.** The staged runtime is about 625 MB on macOS arm64 (the worker
  236 MB, SeaweedFS and NATS 149 MB, Node.js 112 MB, the app 84 MB).
- **Worker data path in a checkout.** The worker prefers a `pnpm-workspace.yaml`
  above its working directory for `docstore/`, so a runtime run from inside the
  repository (`desktop/stage` or `desktop/dist`) keeps models in
  `desktop/docstore/` (ignored), next to `desktop/pnpm-workspace.yaml`.
  Installed apps are unaffected.
- **Associations on Linux.** The `.deb` registers the MIME types. The AppImage
  registers nothing unless the user integrates it.
