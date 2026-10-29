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

Its installed name is **OpenReader Desktop**, distinct from the OpenReader iOS
app available on macOS. The bundle identifier stays `dev.richardr.openreader`,
and the shell pins its userData directory to `<appData>/OpenReader` so the
rename preserves existing libraries, secrets and browser sessions.

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
  src/updates.mjs        automatic updates from GitHub Releases
  src/runtime.mjs        ports, environment, spawn/stop, readiness, token exchange
```

The staged runtime mirrors the Docker image:

| Path | Contents |
|---|---|
| `node/` | the official Node.js binary (the version that ran staging) and its LICENSE; on Linux, `lib/libatomic.so.1`, which it links and some systems lack |
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
  `IMPORT_LIBRARY_DIRS`, and `RUNTIME_SEED_JSON` with one provider, `kokoro`
  (`kokoro-local`), so a fresh install has a voice (see "Local voices" in
  `v5/DESKTOP_SINGLE_OWNER.md`). No new variables.
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
- **Readiness.** The window stays hidden until `/api/auth/ok` answers and the
  app's first render, so it only ever shows the app. On a cold start that render
  is the `AuthLoader` loading overlay. A startup failure shows an error box with
  the log path instead.
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

`preload.cjs` exposes `window.openreaderDesktop` with fixed actions:
`onOpenFiles(callback)`, `setTitleBarColors(colors)`, `revealDataFolder()`,
`openLogsFolder()`, and the updater's `getUpdates()`, `onUpdateState(callback)`,
`checkForUpdates()`, `installUpdate()` and `setAutomaticUpdates(boolean)` (see
Updates). The page never passes a path (the shell accepts only two hex colours
for the title bar and a boolean for updates), and the main process ignores
bridge calls from any frame outside the app origin. The UI treats the bridge as
a capability (`useDesktopBridge()` and `useDesktopUpdates()` in `src/hooks`).
Settings → Library and storage offers "Show data folder", Maintenance offers
"Open logs folder", and the update controls appear, only when the bridge has
them.

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

## Updates

The packaged app updates itself from GitHub Releases with electron-updater
(`src/updates.mjs`). Unpackaged runs never check.

- **Automatic updates.** On by default: 30 seconds after the runtime is up,
  then every 4 hours, the shell checks and downloads a newer release in the
  background. Settings → Advanced → Instance → Desktop app turns it off; the choice lives in
  `<userData>/updates.json`, owned by the shell rather than the database, and
  joins that panel's save bar. Off stops background checks and downloads only.
- **Checks.** A check fetches the latest release's feed from GitHub; it sends
  nothing about the library or the owner. The release must be a published,
  non-prerelease release, and one whose feed for this platform is not uploaded
  yet counts as up to date.
- **Where it shows.** The Settings sidebar, under Changelog, has Check for
  updates (in the toolbar on narrow windows); it reads Checking for updates…,
  Downloading v… with a percentage, then Restart to update, and reports a
  manual check's result as a toast. Once an update is downloaded, Restart to
  update also appears above Settings in the library sidebar. The application
  menu has the same item (the app menu on macOS, Help elsewhere), which answers
  in a message box. Nothing appears unprompted otherwise; an update not
  installed through Restart to update installs on the next quit. Downloads are
  differential where the previous release's blockmap exists.
- **Runtime first.** Installing stops the runtime before the app quits, as an
  ordinary quit does (which now ends through `app.quit()`, not `app.exit()`, so
  electron-updater's quit hook runs), so no bundled process holds files the
  installer replaces. The new version runs bootstrap's startup, including
  migrations, against the same userData directory.
- **Platforms.** macOS installs the zip through Squirrel.Mac, which needs the
  signed, notarized release build; an unsigned build cannot install an update
  and logs why. Windows runs the NSIS installer silently and relaunches. Linux
  replaces the AppImage in place, or installs the `.deb` through `pkexec`, which
  asks for a password; an AppImage the user moved somewhere read-only cannot
  update.
- **Logs.** Checks and failures go to `<logs>/updates.log` (rotated at 1 MB);
  background failures appear nowhere else.

## Packaging

`pnpm --dir desktop package` builds for the host: a DMG on macOS, an NSIS
installer on Windows, an AppImage and a `.deb` on Linux, plus a zip on macOS
for updates. The version is the root package version. The `publish` setting
names the GitHub repository, which bakes `app-update.yml` into the app and
writes the update feed (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`,
`latest-linux-arm64.yml`) and blockmaps beside the installers; packaging itself
never uploads. On macOS electron-builder signs every Mach-O in the bundle with
the hardened runtime and Electron's JIT entitlements, which the bundled Node.js
needs; a local build uses whatever identity is in the keychain.

There is no Intel Mac build: onnxruntime-node has shipped no darwin-x64 binary
since 1.24, so `stage` stops there. Desktop and Docker bundle SeaweedFS 4.48.
It must stay at 4.25 or later: older `weed mini` routes its internal gRPC
through `/tmp` Unix sockets, which do not exist on Windows (seaweedfs#9430).
Newer `weed mini` keeps its SSE-S3 key in `.mini_sse_kek` and ignores the key
an older version stored on the filer, so an upgraded data directory's objects
would stop decrypting. After weed starts, bootstrap reads the filer's key
(unwrapping it with `.mini_kek_passphrase` when weed has wrapped it), writes it
to `.mini_sse_kek` when the two differ, and restarts weed once. This also
repairs a directory a newer weed already opened without that step.

## CI

`.github/workflows/desktop.yml` runs on pull requests that touch `desktop/`,
`packaging/` or `packages/bootstrap/`, on demand, and when a GitHub Release is
published. Each of macos-15, windows-2025, windows-11-arm, ubuntu-24.04 and
ubuntu-24.04-arm builds the app with Node.js 26.12.1, stages, runs
`pnpm --dir desktop smoke`, packages and uploads the installers for seven days.
Installers are named `OpenReader-Desktop-<version>-<arch>.<ext>` on every platform.

Pull requests package unsigned. A published release builds its tag, which must
be `v` plus the root package version. Its macOS job runs in the `Release`
environment: electron-builder signs with `MAC_CERTS` (a base64 Developer ID
Application `.p12`) and `MAC_CERTS_PASSWORD`, then notarizes and staples with
the App Store Connect API key (`APPLE_API_KEY_P8`, the base64 `.p8`;
`APPLE_API_KEY_ID`; `APPLE_API_ISSUER`), and the job requires `spctl` to report a notarized Developer ID app.
A final job attaches every installer to the release, then the update feeds, so
an installed app never reads a feed naming a file not yet uploaded. Windows x64
and arm64 each build their own `latest.yml`; the job merges them with `yq` into
one feed listing both installers, and electron-updater installs the one whose
name has its architecture. Until that job finishes, a new release has no feed
and installed apps keep the version they have. To redo a release, run the
workflow by hand with its tag as `release_tag`; existing installers are
replaced. A manual run with `sign` checked signs and notarizes without touching
a release, to check the credentials. Windows and Linux installers are unsigned.

The public download page (`/download`) lists installers from the docs changelog
feed, never the GitHub API: `scripts/build-changelog-feed.mjs` adds each
release's `desktop_installers` (name, URL, size, platform, arch, format) and the
repository's star count. Attaching assets fires no release event, so the final
job then dispatches Docs Deploy with the tag to refresh that release in the
feed. Every other Docs Deploy also refreshes the newest releases' installers,
so a push that cancels that run cannot leave a release without them.

The smoke test starts the staged runtime in temporary directories and checks
that a wrong launch token gets 401, the real one returns an HttpOnly session for
the admin owner, `/app` loads without a redirect, the runtime runs until
stopped, and the token never reaches the log. It needs no TTS provider and does
not open a window.

## Building

```bash
pnpm build
pnpm --dir desktop install
pnpm --dir desktop stage
pnpm --dir desktop smoke
pnpm --dir desktop start
pnpm --dir desktop package
```

`stage` fetches the pinned ffmpeg and checks it against the SHA-256 values in
`packaging/ffmpeg/manifest.json`. To use a local build instead, pass
`--ffmpeg-dir <dir>` laid out like `fetch.mjs` output.

## Not done yet

- **Windows signing.** Windows installers and updates are unsigned, so
  electron-updater cannot verify the publisher and SmartScreen warns on a fresh
  install.
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
