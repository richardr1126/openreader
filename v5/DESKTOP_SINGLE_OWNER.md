# V5 Desktop Single-Owner Profile

Status: web-app side implemented 2026-10-14 (see "Implementation status" at the
end). The Electron shell, preload bridge, file associations and the Local
voices card are not implemented.

## Decision

The desktop build (an Electron shell around the slim runtime) runs the same
OpenReader as every other deployment. Better Auth sessions, admin grants, the
four existing authentication boundaries and every route-level authorization
check stay exactly as they are. The person using it never sees an account, a
sign-in page or a password.

Desktop differs in three places:

1. **Sign-in.** A fifth authentication boundary, desktop shell to Next.js, uses
   a per-launch secret to obtain an ordinary Better Auth session for the one
   owner. There is no password anywhere.
2. **Presentation.** A read-only deployment fact, `installProfile`, tells the UI
   to hide multi-user administration and to use desktop-shaped layouts.
3. **Native capabilities.** An Electron preload bridge offers file-manager and
   file-dialog actions. The UI uses them when the bridge exists.

The profile never grants, skips or relaxes authorization. The owner is an
ordinary admin account that happens to be the only one. It exists because every
document, setting, cache entry and usage record is owned by a user, and every
route checks a session; one real owner row keeps all of that unchanged.

## Why loopback is not enough

Every desktop listener binds `127.0.0.1`: Next.js (`HOSTNAME`), the worker
(already defaults to loopback), embedded NATS (already loopback) and SeaweedFS
(`WEED_MINI_BIND_HOST`). Ports are chosen free at launch, not fixed at 3003 and
8081.

Loopback is still reachable by other local users and processes and by web pages
in the user's ordinary browser (CSRF and DNS rebinding). Sessions, the worker
token, the HMAC playback token and the broker token therefore remain required.
Removing them would turn a desktop install into an unauthenticated local
service.

## Authentication boundaries

The four boundaries in `v5/AUTHENTICATION_PLAN.md` are unchanged:

1. browser to Next.js: Better Auth session cookie;
2. Next.js to worker: `COMPUTE_WORKER_TOKEN`;
3. browser to worker audio: short-lived HMAC playback token;
4. worker to app broker: `COMPUTE_CREDENTIAL_BROKER_TOKEN`.

Desktop adds:

5. **desktop shell to Next.js: `DESKTOP_LAUNCH_TOKEN`.** It is used only to
   obtain a boundary-1 session cookie. After that the desktop app runs on the
   same four boundaries as every other deployment.

`AGENTS.md` and `v5/AUTHENTICATION_PLAN.md` must list the fifth boundary when it
is implemented.

## Per-launch owner session

### The token

On every launch the shell's main process generates 32 random bytes and passes
them to the app process as `DESKTOP_LAUNCH_TOKEN`, the same way bootstrap passes
`COMPUTE_WORKER_TOKEN` to the embedded worker. The token lives only in the shell's
memory and the app process environment. It is never written to disk, the
renderer, a URL, a log or the database. A new launch makes the previous token
worthless.

The worker never receives it. `packages/bootstrap` must not forward it into the
worker's environment, and the boundary check covers that.

### The exchange route

One internal route, implemented as a Better Auth plugin endpoint so session
creation and cookie signing use Better Auth's own code:

`POST /api/auth/desktop/session` with `Authorization: Bearer <token>`

- **Not configured means not present.** When `DESKTOP_LAUNCH_TOKEN` is unset the
  plugin is not registered and the path returns 404. Server, Docker and Vercel
  deployments never have it.
- **Verification.** Constant-time comparison against the configured token.
  Requests that carry an `Origin` header are refused, because the shell calls it
  from the main process and a browser page has no business calling it.
- **First call** (no owner yet): in one transaction, create the owner user with
  no credential account, grant managed admin access, close signups
  (`signupPolicy: closed`), turn guest sessions off, set the existing
  `initialAdminBootstrapped` marker so the password bootstrap path stays inert,
  and record the owner's user id. Implementation must check the marker's current
  shape before deciding where the owner id lives; prefer the existing marker or
  key-value settings over any schema change.
- **Every call:** create a session for the owner and return the cookie. It never
  creates a second user and never acts for any other account.
- Errors return 401 without detail and are logged without the token.

### Shell flow

1. Start the runtime with `DESKTOP_LAUNCH_TOKEN` set and wait until it is healthy.
2. Call the exchange route from the main process and put the returned cookie into
   the window's cookie store with `session.cookies.set`.
3. Open the window at `/app`.
4. If the window ever navigates to `/signin` (an expired or revoked session), the
   shell cancels that navigation, repeats step 2 and reloads.

Nothing needs recovering: there is no stored credential to lose. If the owner
row is somehow deleted, the next exchange recreates it, while the existing data
stays owned by the old id. That is a data-recovery problem, not an access
problem, and is out of scope here.

## The profile signal

`installProfile: 'server' | 'desktop'` is a **derived deployment fact**, added to
the public runtime config in `src/lib/server/runtime-config.ts` next to
`computeAvailable` and `accountEmailsEnabled`, and to `RuntimeConfig` in
`src/contexts/RuntimeConfigContext.tsx`. It is `desktop` when
`DESKTOP_LAUNCH_TOKEN` is configured and `server` otherwise. So desktop adds
exactly one environment variable, set only by the shell. The profile is not a
row in `admin_settings` and not in `RUNTIME_CONFIG_SCHEMA`, so no admin can toggle
it and no migration is needed.

Rules for its use:

- Read it through `useRuntimeConfig()` on the client and the public runtime
  config on the server. No component reads the environment directly.
- It may filter settings sections, choose layouts and pick defaults.
- It must not appear in any authorization decision, middleware, route guard,
  Better Auth hook or credential-broker path. The exchange route authorizes with
  the token itself, not with the profile. Add a `check:compute-boundary`-style
  lint that fails if `installProfile` is referenced under `src/app/api/**`,
  `src/lib/server/auth/**` or `src/middleware.ts`.
- Server-side restrictions on desktop come from the ordinary settings the first
  exchange writes: signups closed, guests off. The hidden Users routes stay
  mounted and admin-guarded.

The section filter in `SettingsPage.tsx` already filters on runtime config
(`enableTtsProvidersTab`) and on `isAdmin`. The profile adds a per-section
`profiles` list rather than new conditionals:

```ts
type SettingsSection = {
  id: SettingsSectionId;
  // ...
  group: 'general' | 'admin';
  profiles?: readonly InstallProfile[]; // omitted = every profile
};
```

## What the desktop profile hides

| Surface | Desktop | Why |
| --- | --- | --- |
| Admin → Users | hidden | one owner |
| Instance → New account sign-ups, Guest sessions | hidden | closed/off at first exchange |
| Instance → Account email (Resend) | hidden | no inbox to verify |
| Account → Email, verification, password | hidden | the owner has no credential |
| Sign out (user menu, Account panel) | hidden | the shell would sign straight back in |
| Sign-in, sign-up, forgot/reset password pages | unreachable | the shell intercepts `/signin` |
| Public landing page at `/` | skipped | the window opens `/app` |
| Compute → per-user limits | hidden | limits protect a multi-user instance |

Everything else stays: Appearance, Storage, Providers, Instance (TTS defaults,
features, Gutenberg), Compute generation settings, Maintenance/System check,
Acknowledgements and the tip link.

The Account section becomes a small **Profile** section: display name only.

## Desktop-shaped areas

- **Settings layout.** On desktop, Admin and General merge into one sidebar
  (there is only one person, so the "Admin" label means nothing): *General*
  (Appearance, Voices, Library and storage, Profile), *Advanced* (Instance,
  Compute, Maintenance), *About* (Acknowledgements, Support). Section ids stay
  the same, so links and tests keep working; only grouping and labels change by
  profile.
- **Voices section** replaces the two provider tabs on desktop: one list of
  voice sources with local Kokoro first (see below), then any OpenAI-compatible
  servers the owner adds.
- **Library.** Native "Open document…" (preload bridge, file dialog), drag and
  drop from the file manager, and `.epub`/`.pdf` file associations that the
  shell routes to the existing upload flow. No new upload route.
- **Storage.** Shows the data directory, with "Reveal in file manager" (bridge).
- **Maintenance.** System check plus "Open logs folder" (bridge).
- **External links** (tip link, docs, changelog) open in the system browser.
  The shell enforces this with `setWindowOpenHandler`, so the UI needs nothing.
- **Menu bar and shortcuts** belong to the shell: Open… (Ctrl/Cmd+O),
  Settings (Ctrl/Cmd+,), play/pause. Media keys already work through
  `mediaSession`.

The preload bridge is a capability, not a mode. The UI shows a native action
only when `window.openreaderDesktop?.revealPath` (and similar) exists. A desktop
owner who opens the loopback URL in an ordinary browser has no session there
(the cookie lives only in the Electron window) and lands on sign-in, which
offers no way in. That is intended.

## Local voices (model download UX)

Shared by both profiles. On server it lives in Admin → Providers; on desktop it
is the top of Voices.

Card: **Kokoro — on this device**

- State line: *Not installed*, *Downloading 41% (128 of 310 MB)*, *Verifying*,
  *Ready*, *Failed: checksum mismatch — Retry*, or *Update available*.
- Components listed with size and status: model weights, voice pack, English
  pronunciation data.
- Primary action: **Download** (shows the total size before starting), then
  **Cancel** while running, then **Remove** with the reclaimable size.
- Voice picker with a preview button, enabled when every component is verified.
- Progress comes from the worker's existing model-download progress path and
  arrives over existing SSE. No new polling loop.
- Desktop first run: if no voice source is ready, the library shows one
  dismissible banner, "Download a voice to start listening (about N MB)", which
  links to this card.

Sizes above are placeholders until the in-worker Kokoro provider spike reports
measured values.

## Open questions

- Owner email: resolved. The owner is `owner@openreader.localhost`. Besides the
  hidden email UI, `enqueueAccountEmail` refuses every `.localhost` recipient,
  so verification, reset and admin test mail can never be queued for it.
- Whether the server profile should also adopt the Voices layout later.
- Electron packaging (formats, update channel, process supervision) belongs to a
  separate shell document.

## Implementation status

Implemented (web app):

- **Exchange route.** `src/lib/server/auth/desktop-owner.ts` is the Better Auth
  plugin (`POST /api/auth/desktop/session`) and owner creation;
  `src/lib/server/auth/auth.ts` registers it only when
  `src/lib/server/auth/desktop-launch-token.ts` reports a token. Besides
  `Origin`, a `Sec-Fetch-Site` header is also refused: a browser always sends at
  least one of them, the shell's main process sends neither.
- **Owner record.** The `initialAdminBootstrapped` marker keeps its existing
  `{ version, userId }` shape and means "first admin set up". The owner id is a
  separate `desktopOwner` row in `admin_settings` (`{ version: 1, userId }`), so
  a marker left by an upgrade or the password bootstrap is never reinterpreted
  as the owner. No schema change. The grant is `isAdmin: true,
  adminSource: 'managed'`, the same values an admin grant in Users writes. If the
  owner address is held by an account the exchange did not create, the exchange
  fails (500) rather than adopting it.
- **Bootstrap.** `embeddedServiceEnv` in `packages/bootstrap/src/runtime-secrets.mjs`
  drops the token from the worker, NATS and SeaweedFS environments; preflight
  refuses a value shorter than 32 characters.
- **Profile signal.** `resolveInstallProfile()` in
  `src/lib/server/runtime-config.ts`; `installProfile` on `RuntimeConfig`;
  `pnpm check:install-profile` (`scripts/check-install-profile.mjs`), run in the
  Vitest workflow next to `check:compute-boundary`.
- **Presentation.** `src/components/settings/settings-sections.ts` owns the
  sections, the per-section `profiles` list and the per-profile layouts. On
  desktop: Users hidden; Instance hides sign-ups, guest sessions and Account
  email; Compute hides per-user limits (max upload size stays, under
  "Uploads"); Account becomes Profile (display name only); the user menu shows
  the display name without Sign out. Desktop groups: General (Appearance,
  Voice, Voice sources, Library and storage, Profile), Advanced (Instance,
  Compute, Maintenance), About. Until the Voices section exists, the per-user
  provider tab (`api`, "Voice") and the shared providers (`providers`,
  "Voice sources") both sit in General.
- **Landing page.** The window opens `/app`; middleware already redirects a
  signed-in visitor from `/` to `/app`, and the only in-app link to the landing
  page sits in the signed-out Account branch, which desktop never renders.

Not implemented: the shell, the preload bridge actions, file associations,
the Voices section and the Local voices card.
