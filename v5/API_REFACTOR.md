# Public API refactor

Status: accepted; phases 1–5 are implemented. Phase 6 remains planned.

Migration numbers 0028 to 0031 in the history below were combined into `0027_public_api`
by phase 4.9.

This document plans one public API that the web app and third-party clients
share, such as MCP servers, a Chrome extension and scripts, on the hosted
instance and on self-hosted ones. Record implementation history and acceptance
evidence at the end of this document as each phase lands.

---

## Goals

- Let a third-party client sign in as a user and work with that user's library
  and audiobooks through a small, stable, documented API.
- Keep one route per capability. The web app uses the same routes as outside
  clients, and a replaced route is deleted in the change that replaces it.
- Make "make this audiobook" a single request that runs through to the finished
  file.

## Non-goals

- Live playback streaming through the public API. External clients use
  audiobooks, or a `webUrl` that opens the reader.
- Changing live playback, the reader's routes or the playback invariants.
- Personal access tokens. They can be added later on top of the same scope and
  principal handling if self-hosters ask for them.
- The desktop app as an API target, because its ports change on each launch.
- Moving user, session or authorization logic into the worker.

---

## Baseline before the refactor

- **Authentication:** cookie sessions only. `src/lib/server/auth/auth.ts`
  registers `anonymous`, optional `genericOAuth` (signing in through an outside
  provider), the desktop owner plugin and `nextCookies`. Nothing issues tokens
  to outside clients.
- **Middleware:** does not block bearer requests, because API routes
  authenticate themselves. The production region check in `src/middleware.ts`
  does apply to them.
- **Route shapes:** written for the web client.
  - An export needs a `planObjectKey` and full voice settings from
    `reader-bootstrap`.
  - An upload takes presign, PUT and finalize calls.
  - `documents/import-url` returns markdown without creating a document.
  - Resources are often addressed by query parameter, and error bodies vary.
- **Where work runs:** the worker already does parsing, planning, generation and
  assembly. Generation continues after a client disconnects, up to
  `ttsPlaybackBackgroundExtent` for live playback and the whole document for an
  export.

### The audiobook gap

A client request starts each export step. The only caller of
`createTtsPlaybackExportArtifactOperation` is
`src/app/api/tts/export/resolve/route.ts`, and the worker never starts assembly
itself. In the web app, an effect in `src/hooks/audio/useAudiobookExport.ts` calls
`run('start')` when it sees generation complete. If nothing has the export open
at that point, the audio stays cached but the file is not built until someone asks
again.

Confirmed on 2026-11-01 with a 480-segment text document, voice F1 and MP3, on an
isolated local stack. The reader page was closed right after Generate. Generation
ran to completion with no browser in about 25 minutes, but no assembly job started
in the 2 minutes 19 seconds before the export panel was opened again. Opening the
panel sent `start`, and assembly then finished in about a second. Assembly is cheap;
only the trigger is missing.

---

## Architecture

| Piece | Owner | Notes |
|---|---|---|
| OAuth, token checks, scopes, consent, Connected apps | Next.js | Owns users, sessions and SQL; the worker must not query the database |
| `/api/v1` and `/api/mcp` | Next.js | Short requests that authorize, then create or read operations |
| Parsing, conversion, plans, TTS, assembly | Worker | Unchanged ownership |
| Audiobook step progression | Next.js | `advanceAudiobook` starts each step; the worker runs it and reports completion |

No v1 or MCP request may wait for compute. On Vercel:

- Requests return a status at once rather than holding open until work finishes.
- Uploads and downloads use presigned storage URLs so file bytes do not pass
  through a function. Self-hosted proxy mode keeps streaming.
- Optional SSE progress stays within the existing 300-second function limit, and
  clients must be able to reconnect. Polling a resource's status is the main
  path for external clients. The rule against new polling loops applies to the
  reader UI.

### Route ownership

Each capability has one route. Public and private routes do not overlap.

| Area | Before | After |
|---|---|---|
| Audiobooks | `/api/tts/export/*` | `/api/v1/documents/{id}/audiobooks` |
| Documents | `/api/documents`, `documents/blob/*`, `documents/import-url`, `documents/folders` | `/api/v1/documents`, `/api/v1/uploads` |
| Folders | `/api/folders` | `/api/v1/folders` |
| Voices | `/api/tts/voices` | `/api/v1/voices` |
| Live reader and playback | `documents/[id]/reader-bootstrap`, `tts/stream/*`, seek layout | Unchanged, private |
| Admin, account, user state | Existing routes | Unchanged, private |

Check each moved area against what the app needs before deleting its route.
Known needs are filtering and deleting by a list of IDs, and document previews.
A capability v1 should not expose stays on a private route, without duplicating
a public one.

Keep route handlers thin. Logic moves into shared server modules that take a
resolved principal rather than a request, including helpers such as
`resolveSegmentDocumentScope` and `resolveReaderBootstrapState`.
`resolveReaderBootstrapState` updates `recentlyOpenedAt`, so that side effect
must stay with opening the reader and not run on API reads.

---

## API

All routes are under `/api/v1`.

| Route | Purpose |
|---|---|
| `GET /me` | Current user, granted scopes and compute limits |
| `GET /documents` | List or search, with `cursor`, `limit`, `q` and `folderId` |
| `POST /documents` | Add a document from `url`, `text` or `uploadId` |
| `POST /uploads` | Get a URL to upload a file to |
| `PUT /uploads/{uploadId}/file` | Transfer bytes when the instance uses proxy uploads |
| `GET /uploads/{uploadId}` | Read conversion status and finalize the canonical document |
| `GET /uploads/{uploadId}/events?opId=` | Observe the upload's conversion operation |
| `GET /documents/{id}` | Details and status: `processing`, `ready` or `failed` |
| `PATCH /documents/{id}` | Rename or move |
| `DELETE /documents/{id}` | Delete |
| `PATCH /documents` | Move up to 200 explicitly selected documents |
| `DELETE /documents?ids=...` | Delete up to 200 explicitly selected documents |
| `GET /documents/{id}/file` | Download the original file |
| `GET /voices` | List available voices with stable IDs |
| `POST /documents/{id}/audiobooks` | Start an audiobook, or return the matching existing one |
| `GET /documents/{id}/audiobooks/{audiobookId}` | Status, progress and download link |
| `DELETE /documents/{id}/audiobooks/{audiobookId}` | Stop generation |
| `POST /documents/{id}/audiobooks/lookup` | Read the state of given settings without creating anything |
| `GET /documents/{id}/audiobooks/events?opId=` | Live progress for one of its operations |
| `GET /documents/{id}/audiobooks/files/{artifactId}` | Download the finished file |
| `GET`, `POST`, `DELETE /folders` | List, create or remove all folders (keeping documents) |
| `PATCH`, `DELETE /folders/{id}` | Rename or delete a folder |

Example:

```http
POST /api/v1/documents
{ "source": { "type": "url", "url": "https://example.com/article" } }

POST /api/v1/documents/{id}/audiobooks
{ "voice": "voice_id", "speed": 1.2, "format": "m4b", "chapter": 3 }

202 Accepted
{ "id": "...", "status": "generating", "progress": 0.12, "webUrl": "https://..." }

GET /api/v1/documents/{id}/audiobooks/{audiobookId}
{ "id": "...", "status": "ready", "downloadUrl": "...", "webUrl": "..." }
```

- All audiobook fields are optional. `voice` falls back to the document's saved
  settings, so no client needs to know about plans or sessions.
- Lists return `{ data, nextCursor }`.
- Errors return `{ error: { code, message, retryAfterMs? } }`. A 429 also sets
  `Retry-After`.
- The spec is published at `/api/v1/openapi.json`.
- The `/v1` prefix marks what outside clients may rely on. Private routes can
  keep changing freely.

---

## Authentication

`@better-auth/oauth-provider` and Better Auth are both on 1.7.15. Phase 4 adds
dynamic client registration, authorization code with S256 PKCE, rotating refresh
tokens, device authorization and discovery metadata. Implementation details and
acceptance evidence are recorded below.

The grants cover each client type:

| Client | Flow |
|---|---|
| Remote MCP (Claude, ChatGPT) | Authorization code with PKCE and client registration |
| Chrome extension | `chrome.identity.launchWebAuthFlow` as a public client with PKCE |
| Local tools | Authorization code with a loopback redirect |
| CLI or headless scripts | Device flow, then a refresh token |

- Browsers keep the Better Auth session cookie. OAuth is only for third-party
  clients. The cookie is unreadable by page scripts, `EventSource` cannot send an
  `Authorization` header, the sign-in and consent pages depend on the cookie
  session, and guest and desktop sessions both end in one.
- OAuth access tokens are JWTs, so `getSession()` does not accept them. Internal
  routes stay closed to tokens as a result.
- One helper resolves a v1 request to `{ userId, scopes, clientId? }` from either
  a session cookie or a bearer token. A cookie gets the web app's full access and
  requires same-origin protection.
- OAuth is a sixth authentication boundary. Add it to `AGENTS.md` and
  `v5/AUTHENTICATION_PLAN.md`, kept distinct from the existing five.
- `installProfile` must take no part in any of this.

### Scopes

- `documents:read`, `documents:write`, `audio:generate`, enforced in the shared
  helper.
- Tokens never reach admin routes, provider settings, account deletion, data
  export or token management.
- Guests must sign in to a real account before approving an app.
- MCP and v1 use separate token audiences, so a token issued for one cannot be
  used on the other.

### Consent and revocation

- The consent page shows the app's name, its real redirect domain and the scopes
  it requested. Clients that registered themselves are labeled unverified, since
  anyone can register one called "Claude".
- Redirect URIs match exactly, PKCE is required and refresh tokens rotate.
- A Connected apps page in Settings lets users revoke access per app.

### Compute limits

Third-party apps share the user's existing compute limits, and the consent screen says
so when an app asks to generate audio. Requests from a hosted MCP client arrive from that
vendor's IP, so limits key on the
user. There is no per-app limit: a client using up its user's quota affects only that user.

---

## Phases

Each phase from 1 to 3 moves the app onto the new routes and deletes the old
ones in the same change, including callers, tests and active documentation.

### Phase 1: Audiobooks

1. Add the `audiobook_requests` table described below.
2. Add `advanceAudiobook`, one idempotent server function that checks the current
   state and starts whichever step is due: PDF parse, plan, generation or assembly.
   Each step goes through the same compute admission as today. It stops rather than
   advancing when a step fails or generation hits the usage limit. If admission limits
   the final compile after the audio has finished, the audiobook reports that it is
   waiting and retries on the next status check or finished operation. It runs:
   - on `POST` and `GET` of an audiobook;
   - when the worker reports that an operation finished, using a small signal on
     the existing worker-to-app boundary, authenticated with
     `COMPUTE_CREDENTIAL_BROKER_TOKEN`. The existing `limits/complete` callback
     shows where the worker reports this.

   If a signal is lost, the next `GET` still advances the export.
3. Add the audiobook routes, the shared principal helper with cookie support, and
   the conventions above. Cancel behavior, chapter exports and retrying skipped
   segments must carry over.
4. Move the export UI over and delete `/api/tts/export/*`.

The worker keeps each step as its own operation. A single worker job running every
step was rejected: the app owns compute admission and resolves live settings and
voices, so moving those into the worker would cut across that boundary.

#### `audiobook_requests`

The app needs to remember what was requested so it knows what to do when the worker
reports back. The table goes in both the Postgres and SQLite schemas and records:

- the owning user and the document;
- format, speed and chapter;
- the voice settings resolved when the request was made.

Rules for the table:

- **Intent only:** generation and artifact status stay in worker operations, so the
  table does not become a parallel source of truth. Stopping an audiobook ends its
  request.
- **No secrets:** it stores settings and provider references, never provider
  credentials.
- **Deduplicated:** a repeated request for the same document, settings, format, speed
  and chapter returns the existing one. A request for another format during a running
  generation gets its own row and is assembled when generation settles.
- **Cleaned up:** document and account deletion remove their rows.
- **Signed-in users only on signals:** admission from a worker signal has no client
  request, so no client IP or guest device ID. A signal advances requests from signed-in
  users, with limits keyed on the stored user ID. Guest requests do not advance on a
  signal: a guest's export is compiled when they next have it open, as it is today. Their
  audio still finishes and stays cached, and no guest device data is stored.

### Phase 2: Documents and uploads

1. Add server-side document creation from `url`, `text` or `uploadId`.
2. Add document status covering DOCX conversion and PDF parsing.
3. Move the app's library and upload flows over, then delete the old routes.

### Phase 3: Folders and voices

Move these with no behavior change, then publish the OpenAPI spec and docs for
the full v1 surface.

### Phase 4: OAuth

Add the provider, its tables and the `/.well-known` metadata, then the consent
page, Connected apps, scopes and bearer support on v1.

### Phase 4.5: Hardening before MCP

Phase 5 builds on these routes, so a review of phases 1–4 is closed out first.
Nothing here adds a public capability.

Blockers:

- Serve stored documents as downloads with a content type the server derives from
  the document type, so an upload cannot run script on the app origin.
- `documents:read` never starts or advances compute. Only `audio:generate` does.
- The off switch for client registration also closes the managed client routes.
- Audiobook locks use their own small connection pool with lock and transaction
  timeouts, and worker calls have a default deadline, so a slow worker cannot
  exhaust the database pool.
- A document stays registered when its first layout parse is refused or the worker
  is down. Status polling retries the parse.

Fix soon:

- **Stop:** stopping a running export cancels the shared generation and ends every
  whole-book request sharing that session. The other format then returns 404, and
  POST resumes it. Stopping with nothing running ends only that request.
- **Retention:** finished requests stay addressable for 7 days.
- Only the `Bearer` scheme counts as a token attempt. The device page keeps its
  destination through sign-in. Empty uploads are rejected, and the size is rechecked
  at every finalize.
- Document status reports `unknown` when the worker cannot answer, and `not_started`
  when no parse exists. Plan resolve applies the staleness rule.
- Errors, Retry-After and cache headers match the published contract, and OpenAPI is
  checked against real responses.
- Tests cover deletion against a real database. A scheduled task purges expired OAuth
  rows. Migration 0028 is rewritten in place with a unique `oauth_consent (user_id,
  client_id)` index, so databases that ran the earlier 0028 must be reset.

Smaller fixes: chapter GET 404, rebuild after retried skips, custom-scheme display
on consent, registration field limits, 503 when DOCX conversion has no worker.

### Phases 4.6 to 4.8: Limits before MCP

Nothing owns a user's storage total, and nothing bounds what a user or guest can add.
The admin list sums source files only, while the settings page lists audio and derived
data by scanning object storage on every load. Adding a document has no limit beyond
the upload size, and eight of the nine compute actions track guests per user, so a new
guest session resets them. MCP makes these easier to hit, so they land first. None of
these phases adds a public capability.

The phases run in order, with one commit each. Each one finishes with the complete Vitest
suite and Playwright matrix.

Admin settings for all three follow one pattern, and all are hidden on desktop: a toggle,
off by default, reveals its value already filled in with the default. A limit is hidden
when its feature is off.

### Phase 4.6: Account creation and IP handling

Limit accounts where they are created, and never store a raw IP.

- **Creation caps:** both are enforced in the user-create hook, which every sign-up path
  passes through, and count in the existing limit tables.
  - Guests use a rolling window equal to the guest idle period, so older guests are normally
    deleted before an IP gets more. Default: 10.
  - Full accounts have their own count and period, because they are never cleaned up and
    carry larger limits. Default: 5 per 30 days.
  - A request with no known IP is not capped.
- **At a cap:** the app stops retrying guest creation and shows the sign-in page, and
  sign-up shows an error. Existing guests and accounts keep working.
- **Hashed IPs:** every stored IP is a keyed hash, with IPv6 grouped by /64.
  - The session create hook replaces `session.ip_address` before the row is written, using
    its own label so session values cannot be matched against limit counters.
  - Do not use `disableIpTracking`, because Better Auth's rate limiter needs the IP. Test
    that the limiter still works.
  - The migration clears existing raw values, because SQL cannot compute the keyed hash.
  - Account exports leave the IP out.
- **Delete device and per-IP limits:** remove the device limit, the device ID cookie and
  per-IP limits for guests and signed-in users, along with the IP and device values routes
  pass to the limits system. The creation caps are the only IP check left. Drop
  `device_scope_key` and `ip_scope_key` from `compute_limit_admissions`.
- **Saved policies:** policies that still hold device or IP rows must load with those rows
  removed. Test this against a saved copy of the old format, because a rejected policy could
  leave limits not applying as the admin set them.
- **Settings:** "New accounts per IP", with count and days, goes under New account sign-ups.
  "New guests per IP" goes under Guest idle period, labelled with the current period. If the
  Delete idle guest accounts task is off, say that guests are never removed and link to Tasks.
- **Privacy policy:** update what it says about IP values and the anonymous-device cookie.

### Phase 4.7: Storage and intake

Give each user one storage total, shown everywhere and enforced by caps.

- **Usage table:** one row per user and document holding audio bytes (segments, sidecars
  and exports). The worker measures only the affected document during a run, when it
  finishes and after audio is cleared, then reports to an internal route using the broker
  token. A late report must not bring back a row for audio that has been deleted. Pages
  never trigger a measurement.
- **One total:** one server function returns documents (`sum(documents.size)`), audio
  (`sum` of the usage rows) and their total. The admin list, settings page and caps all
  read it, and the library scan is deleted. Derived data is shared and regenerable, so
  it is not charged to a user. The per-document section and audio deletion keep their
  one-document scan for the breakdown by settings.
- **Backfill and repair:** one scheduled task creates rows for existing audio and later
  repairs recently active users. The work runs on the worker.
- **Storage caps:** separate guest and signed-in values. Uploads are checked in
  `prepareDocumentUpload`, and audio where daily characters are charged, so cached audio keeps
  playing. Confirm that check runs when the character limit is off. A run that hits a cap
  stops in the existing usage-limited state.
- **Guest storage pool:** one setting for the total all guests can use. When it is full,
  guests cannot upload or generate new audio. Signed-in users are unaffected.
- **`document_intake`:** a per-user daily file limit with a smaller guest value, checked
  before any URL fetch. It has no execution block and joins `ADDITIVE_COMPUTE_ACTIONS`.
- **Settings:** storage per account, storage per guest and total guest storage go beside Max
  upload size. The daily file limit goes in the compute limits editor, beside characters.
- **Showing usage:**
  - Admin users shows one storage total per user, with documents and audio in its details.
  - User settings shows the same total and breakdown, with used against the cap when one is on.
  - When a cap blocks an action, the message says which limit was hit and links to Storage to
    free space. Guests also get the option to create an account.

### Phase 4.8: Guest retention notice

Tell guests how long their data lasts before the idle period gets shorter.

- When "Delete idle guest accounts" is on, tell a guest once, in the onboarding flow, how long
  an idle guest account is kept, with a direct way to create an account. Show nothing when
  the task is off.
- Claiming an account moves documents, but no audio move was found in the claim code. Check
  what happens to a guest's audio on sign-up so the notice promises only what is kept.
- State guest retention in the privacy policy.

### Phase 5: MCP

Add `/api/mcp` as a stateless streamable HTTP endpoint on the same shared logic.
Tools: `list_documents`, `add_document`, `list_providers`, `list_voices`,
`create_audiobook` and `get_audiobook`.

- Tools return a status at once and never wait for an audiobook to finish.
- Tools return `webUrl`, a ready-to-play link to the reader, for the user to open,
  because a link that needs a bearer token cannot be clicked in chat. They never
  return a raw worker audio URL or a playback token.
- No local MCP package is needed at first, since OAuth handles sign-in.
- Use the MCP SDK (`@modelcontextprotocol/server` v2 with zod).
- Accept and document the re-consent cutoffs clients have.
- Test locally with MCP Inspector, and optionally a desktop client, before merging. Hosted
  connectors need a public HTTPS address, so test those on production during final
  verification, since there is no preview stack.
- No request rate limit specific to MCP. Compute, storage and file limits cover cost.
- Client registration supports CIMD and DCR on all instances, with one admin switch. This
  needs `@better-auth/cimd`.
- No CORS on `/api/mcp`. The Origin check is required either way.

### Final verification before release

Nothing merges to `main` until phase 5 is done, so phases 1 to 5 reach production together.
These steps are for the owner.

- Take a backup, because dropped columns and cleared IPs can only be recovered from one.
  Apply the migrations with the old version offline, then deploy web and worker together.
- Smoke-test production, then test the MCP connectors against it.
- Run the storage backfill, then set the creation cap, character and storage values from real
  usage. Production peaked at 5 guests per IP over 14 days.
- Turn on "Delete idle guest accounts" at the 90-day period. The guest notice only appears
  while the task is on, and the first run deletes guests already idle 90 days.
- Lower the idle period to 14 days only after the notice has been live for a while, because
  the next run deletes guests already idle that long. Guests who saw the longer period are
  told again.

### Phase 6: Chrome extension

The extension signs in through OAuth and takes an instance URL, so it works with
self-hosted servers.

- It sends the page's rendered text to `POST /documents`, because the server
  cannot see logged-in or paywalled pages and its URL fetch is capped at 2 MB.
- Extensions with host permissions bypass CORS, so do not add
  `chrome-extension://` origins to `trustedOrigins`.

---

## Self-hosting

- Clients take a base URL and discover everything else from `/.well-known/*`, so
  one extension or connector works with the hosted instance or any self-hosted
  one.
- The token issuer follows the instance's base URL, so changing that URL affects
  existing tokens. Document this in the deployment docs.
- Add new environment variables only if a phase shows they are necessary. Prefer
  runtime settings, as with `allowAnonymousSessions`.

---

## Decisions

1. **OAuth and `jwks` tables:** add them to the Postgres and SQLite schemas in phase
   4. Production needs a coordinated migration when that phase lands.
2. **US-only check for MCP on the hosted instance:** keep it as is and test with real
   connectors. It reads the caller's IP, which is the vendor's servers rather than
   the user, so a US user could get a 451 if those servers are abroad, and someone
   abroad could get through via US ones. Exempting these routes would weaken the
   restriction, so revisit only if testing shows a real problem.
3. **Open client registration:** on by default, with the unverified label on the
   consent screen and an admin off switch stored as a runtime setting.
4. **Order:** phases run as numbered. OAuth and MCP follow the web app's move to v1.
5. **Browser authentication:** browsers keep cookies, and OAuth is only for third-party
   clients.
6. **Audiobook progression:** the app advances steps through `advanceAudiobook`, with a
   new `audiobook_requests` table in phase 1. Production needs a coordinated migration
   when that phase lands.
7. **Guests:** OAuth never admits guests. Guest exports in the web app advance only on the
   guest's own requests, so the closed-tab fix is for signed-in users.
8. **Limit reached at compile:** the audiobook waits and retries rather than failing.
9. **Third-party usage:** apps share the user's limits, with no per-app limit.
10. **Creation caps replace per-IP limits:** limit guests and accounts where they are created
    instead of keeping IP limits on characters or adding them to each action. Permanent
    per-IP counts are out, because IPs get reassigned and shared. The device ID is out too:
    it is a cookie, so clearing it along with the guest session resets it.
11. **Stored IPs:** hash every stored IP with a keyed hash. Hashing keeps per-IP counts and
    same-IP comparison for abuse and account investigations without storing addresses.
12. **Storage measurement:** the worker measures per document when audio changes. A live
    byte counter is out, because it would hook every write and delete and still need the
    same scan to repair drift.

---

## Risks to check

- **Old clients:** before deleting a route, confirm nothing still in use calls it,
  including shipped desktop builds and any native client. Desktop bundles its own
  server and web app, so it should move together.
- **Playback:** audiobook and document changes share code with the reader, such as
  plan preparation. They must not alter session identity, cached audio reuse or
  any other playback invariant.
- **Test coverage:** browser and unit tests name the old routes directly, including
  `tests/e2e/export-workflows.spec.ts` and `tests/e2e/docx-conversion.spec.ts`.
  Update them with each phase. Run the full Vitest suite and Playwright matrix
  before each phase is complete.

---

## Implementation history

### Phase 1: Audiobooks

Delivered: the `audiobook_requests` table (migration `0027`, not yet applied to
production), `advanceAudiobook`, the audiobook routes, the principal helper with cookie
support, the error shape, the moved export UI, and removal of `/api/tts/export/*`.

Where it differs from the plan above:

- **The existing completion signal is reused.** The signal is `limits/complete`, which
  already fires for every finished operation. The app now also advances audiobooks from
  it, in `after()`, because the worker awaits the callback before acknowledging its job.
  A read-only worker `POST /v1/tts-playback/plans/resolve` distinguishes plan discovery
  from enqueueing: status reads do not spend admission again or retry a failed plan.
- **PDF parse is not an `advanceAudiobook` step.** The settings hash needs the detected
  language, so a request using saved settings on an unparsed PDF starts the parse and
  returns `409 DOCUMENT_PREPARING` with a retry hint until it is ready. A closed-tab
  request therefore has to retry until the parse has finished.
- **Three more routes.** `lookup` exists because the web app must read the state of its
  current settings without creating a request. `events` and `files` replace the old
  export events and download routes.
- **The web app sends explicit settings.** It passes `settings`, `planning` and
  `planObjectKey` so its cache identity matches the reader. Third parties use saved
  settings and the optional `voice`.
- **Explicit plan references are checked.** The plan artifact must match the document,
  version and reader type, and its stored owner (when present) must match the caller.
  Legacy artifacts without owner metadata remain readable; bearer-token review is
  still required in phase 4.
- **A chapter request never starts generation.** It builds a chapter whose segments are
  settled, and creates a row only while its file is building or waiting.
- **`downloadUrl` is relative.** `webUrl` is absolute, from `BASE_URL`.
- **Stop deletes the request.** `DELETE` returns the stopped audiobook; a later `GET` of
  that ID is `404`. A changed document version also deletes the row.
- **Commands are serialized per owner/document.** SQLite uses a process-local queue;
  Postgres uses a transaction-scoped advisory lock across app instances. This includes
  formats sharing the same generation session, so a signal/GET cannot double-admit
  a compile and an in-flight advance cannot restart work after Stop. Chapter Stop is
  rejected, as in the replaced route.
- **An operation reference survives session expiry.** `settingsJson` also records the
  generation operation ID, never its status or credentials. Reads use worker state to
  preserve failures/usage limits after the session expires. A missing operation needs
  explicit Resume. Transient reads after enqueueing retain the intent.
- **Events require operation ownership.** Document ownership alone is insufficient
  because document IDs identify content shared by different users. The admission must
  link the requested operation to the caller.
- **Failed stale-file builds do not loop.** A failed rebuild reports `failed` even when
  an older stale file exists, and needs an explicit retry.
- **Saved voice overrides resolve language first.** A requested voice participates in
  automatic language selection before the audio settings hash is derived.

Separate pre-existing worker fix found during acceptance: ONNX Runtime Node 1.30.0
executes native session creation/inference synchronously inside `setImmediate`, despite
returning promises. PDF layout inference now runs on one warm dedicated thread with
the same CPU budget. No compute defaults, browser timeouts, assertions, retries or
Playwright worker counts changed.

Evidence (2026-11-01):

- Before the worker fix, two complete branch matrices had 4 and 3 reader failures;
  an isolated HEAD snapshot with the same stage instrumentation had 5. Playback was
  skipped by project dependencies in those runs. One branch plan spent 3,672 ms in
  artifact persistence overlapping a 3,658 ms native PDF inference. Queueing was not
  the cause of that plan's delay. Completion callback round trips had median 37 ms
  and maximum 1,075 ms before isolation, versus 24 ms and 324 ms afterward; deferred
  audiobook advancement is not on the worker's awaited response path.
- A controlled same-process heartbeat probe using the installed native runtime and
  identical model/input/thread count measured a 440 ms maximum main-loop gap for
  direct session creation/inference and 25 ms with the dedicated inference thread.
  The first full matrix after isolation passed all earlier reader failures; its sole
  failure was a provider-cleanup HTTP connection reset after the UI journey completed.
  That reset has no confirmed product fix. Safe socket diagnostics in the final
  matrix recorded no request resets, and the cleanup case passed; its cause remains
  unconfirmed rather than being attributed to machine load.
- On a disposable stack, a signed-in account started an 11-segment MP3 in the visible
  export panel, then the tab was closed at 0/11. With no browser tab or advancing status
  request, generation finished in 50.34 seconds, its callback queued assembly about
  26 ms later, and assembly finished in 74 ms. Storage metadata proved the ready file
  existed before reopening. The authorized file route downloaded 2,451,742 bytes;
  `ffprobe` verified 153.23 seconds. The reopened panel showed READY and its Download
  control also saved the MP3.
- A separate 7-segment export was stopped at 2/7, then its tab closed. Its intent was
  deleted, its draining worker run ended, and no replacement run or whole-book artifact
  appeared. A completed book's final M4B compile returned `waiting` under an exhausted
  test quota, then `building` and `ready` after restoring the policy and reading status.
  All changes were confined to disposable local state, and that stack was stopped.
- Full Vitest: 1,612 passed across 239 files. Complete Playwright: 79 passed in
  2.7 minutes, including both real Chromium/WebKit playback journeys (about 1.6 minutes
  each); none skipped. Both application/worker TypeScript checks, `pnpm build`,
  `lint:route-errors`, `check:compute-boundary` and `check:install-profile` passed.
  The browser run used a throwaway config only to capture server output and reuse
  the immediately preceding production build; projects, workers, retries and
  assertions were unchanged. Temporary diagnostic logging was removed from product
  code before that build/run. Port 3003 was free after both stacks stopped.

Remaining documented limits: saved-settings PDF requests still require a retry after
`DOCUMENT_PREPARING`; guests advance only on their own requests; owner-less legacy
plan metadata remains compatible pending the phase-4 authorization review. No release,
push or production migration was performed. Migration 0027 still needs the
owner-coordinated production upgrade.

### Phase 2: Documents and uploads

Document creation, listing/search, metadata reads, rename/move, deletion and file
reads now use `/api/v1/documents`. The library, file upload, custom-text, URL and
Gutenberg import clients use these resources. The replaced `/api/documents`
collection, folder-move, URL-import and blob upload/download routes are removed.
Reader bootstrap, bookmarks, settings, recency and previews remain private.

Creation accepts `source: { type: 'text', text }`, `source: { type: 'url', url }`
or `source: { type: 'upload', uploadId }`, with optional `name` and `folderId`.
Upload preparation takes a filename, exact byte size and content type, stores its
metadata on the server, and returns an ID, transfer URL, headers and expiry. Proxy
transfers enforce the declared length; presigned transfers are checked before
submission. JSON control requests are capped at 3 MB, inline text at 2 MB, and
files at the existing configured upload limit. URL extraction retains the existing
SSRF protections and bounded fetch.

Where it differs from the original outline:

- **Conversion has an upload resource.** Existing document IDs are SHA-256 addresses;
  a DOCX's final ID is unknown until the worker produces its PDF. Creation returns
  `202` with the upload status/events URLs until conversion finishes. A subsequent
  status read verifies and registers the PDF, returning the canonical document.
  A closed tab does not prevent conversion, but registration still needs that read.
  No placeholder document ID, schema change or second stored identity is introduced.
- **Receipts use existing temporary storage.** Preparation metadata and the final
  document receipt use the existing owner-scoped receipt objects and cleanup policy.
  Pending uploads expire after 24 hours; presigned transfer URLs expire in five
  minutes. Success receipts recheck ownership and canonical blob integrity.
- **Document status covers PDF preparation.** Creation starts an admitted parse
  when needed. Metadata/status reads resolve worker state without opening a reader,
  changing recency or creating playback plans. DOCX conversion exposes status on
  its upload until a canonical PDF exists. Existing conversions are reused without
  entering compute admission again.
- **Library bulk actions are explicit and bounded.** Lists return `{ data,
  nextCursor }` with a maximum page size of 200, stable ID cursors, literal text
  search, optional ID selection and folder filtering. Collection moves/deletes
  accept up to 200 IDs; the app batches larger selections. There is no implicit
  delete-all request. Renames and moves preserve document versions and playback.
- **Conversion events require upload ownership.** The server resolves the caller's
  receipt and verifies the operation's conversion identity and namespace before
  proxying SSE. Owning another document with matching content grants no upload access.
- **Cookie authentication remains in place.** Every route uses the shared principal
  and public error shape. Bearer support and the OpenAPI publication remain in the
  later planned phases.

Acceptance evidence (2026-11-01):

- On a disposable local stack, the visible app created Markdown directly, opened
  its content in the reader, imported `https://example.com` on the server, uploaded
  PDF and EPUB files, and converted DOCX to a readable PDF. Moving the Markdown
  into a folder persisted after reloading the library. That stack was stopped
  before Playwright started.
- Real-SQL route tests cover owner filtering, cursor pagination, literal search,
  text/URL creation, upload transfer and finalization, repeated receipt integrity,
  metadata mutation ownership, PDF operation status and bounded JSON input. Separate
  tests cover presigned/proxy transfer rules, canonical-copy integrity, conversion
  admission reuse and upload event ownership.
- Full Vitest: 1,623 passed across 240 files. Complete Playwright: 81 passed in
  2.7 minutes, including both real playback journeys (Chromium 1.5 minutes, WebKit
  1.6 minutes); none skipped. New creation coverage verifies the canonical ID,
  reader content and persistence after returning to and reloading the library.
  Its first matrix exposed a test sequencing error: reload cancelled the pending
  return navigation. Waiting for the library URL before reloading fixed the test;
  no timeout, retry, worker-count or product behavior change was needed.
- Application and worker TypeScript checks, the production build, route-error,
  compute-boundary and install-profile checks passed. The browser matrix reused
  the immediately preceding production build through the same temporary logging
  configuration as phase 1. Port 3003 was free after both stacks stopped.

Phase 2 adds no schema migration or environment setting. Phase 3 remains folders,
voices and publication of the full v1 OpenAPI specification and documentation.

### Phase 3: Folders, voices and API reference

Folder routes now use `/api/v1/folders`; item updates use PATCH. Creation still
supports caller-selected IDs and atomic movement of selected owned documents.
Removing one or all folders keeps the documents. Folder lists retain display
order (position, creation time, ID) with bounded cursor pagination. Legacy null
timestamps normalize to zero without changing stored data. Folder resources
omit the internal owner ID; every query and mutation remains owner-scoped.
The client batches selections above 200 documents, as with document bulk moves.

Voice discovery moved to `/api/v1/voices` with provider/model query parameters.
Its list envelope contains provider-native `{ id, name }` resources and the
resolved provider/model. Explicit app selections keep their existing behavior;
default discovery follows the user's saved provider/model using the same pure
selection helper as saved-settings playback. This prevents a catalogue from the
instance default being paired with an audiobook using another saved provider.
Voice IDs and stored selections are unchanged. Personal voice recordings,
previews, provider configuration and live playback stay private.

The planned `/api/v1/me` endpoint returns identity, scopes and the existing binding
TTS character quota. The quota widget uses it, replacing `/api/compute-limits/status`.
Unlike that old route's unauthenticated nominal quota, `me` requires a session;
the widget waits for one. Quota calculations, guest device handling and reset
times are unchanged. No internal bucket IDs or execution credentials are returned.

`/api/v1/openapi.json` publishes the implemented cookie-authenticated surface,
including the upload conversion resource, collection actions and app audiobook
lookup/events/file routes. Its schemes do not advertise unimplemented OAuth.
`docs-site/docs/reference/public-api.md` documents workflows, ownership, scope
requirements, status progression, limits, relative URLs and transport redirects.
Route/method coverage and schema-reference tests guard the specification; the
existing OpenAPI TypeScript tool validates it without adding a dependency.

The replaced folder, voice and compute-status routes and their callers are
removed. JSON parsing for document and folder controls shares the existing
bounded implementation (3 MB for documents, 64 KB for folder controls). This phase
adds no schema, environment setting or runtime library. OAuth remains phase 4.

Acceptance evidence (2026-11-01):

- A disposable local stack verified visible folder creation, movement and reload
  persistence. Removing the folder kept its Markdown document readable. Its
  voice picker loaded the provider catalogue, applied F2 and preserved that
  selection after reloading. The stack was stopped before Playwright started.
- New real-SQL tests cover owner-scoped folder reads and writes, transactional
  creation with document moves, duplicate IDs, cross-owner isolation, stable
  display-order cursors including legacy null timestamps, and document retention
  on folder removal. Voice discovery tests prove that default selection reads
  only the caller's preferences, preserves native IDs, and omits credentials.
  Identity tests cover the binding quota, guest-device cookie and authentication.
- Full Vitest: 1,637 passed across 244 files. Complete Playwright: 81 passed in
  2.8 minutes, with no skips, retries or failures, including both real playback
  journeys. The existing folder journey now also removes its folder and proves
  all four documents remain after reloading. Existing provider/voice selection,
  personal voice, library, conversion, reader and audiobook journeys passed.
- Application and worker TypeScript checks, production build, route-error,
  compute-boundary and install-profile checks passed. The documentation production
  build passed. `openapi-typescript` successfully generated types from the public
  specification, and unit tests verify every implemented v1 method is documented
  and every schema reference resolves. The browser matrix used the unchanged
  project/worker policy and the immediately preceding production build with the
  same temporary logging configuration as earlier phases. Port 3003 was free
  after both stacks stopped.

Next: phase 4 adds OAuth, consent/revocation, bearer scopes and discovery metadata,
with the already-planned, owner-coordinated schema migration. No production
migration, deployment, version bump, tag or push was performed in phase 3.

### Phase 4: OAuth

Better Auth and its OAuth provider are now on matching 1.7.15 versions. Migration
0028 adds the provider, consent, device and JWKS tables in both database dialects,
with existing user/session data unchanged. SQLite's Better Auth adapter owns JSON
serialization; its Drizzle columns use plain text so generated JSON column modes
cannot double-encode scopes, redirect URIs or resource policy. Direct app reads
decode and validate those arrays once. PostgreSQL retains native arrays/JSONB.

Authorization code requires S256 PKCE and exact registered redirects. The device
flow explicitly approves codes in the browser and exchanges them only at the
OAuth token endpoint. Unknown device clients are rejected and the companion
plugin's browser-session token endpoint is disabled. Both flows require the
explicit `BASE_URL/api/v1` resource. Phase 5 later added the MCP audience.
Open dynamic registration is the default; the runtime admin switch stops new
registrations without disconnecting existing apps. Resource administration and
client-credentials grants are not exposed.

Consent displays the self-reported app name, **Unverified app**, actual callback
host (or device code), requested scopes and the signed-in account, with a way to
switch account. The
signed authorization query survives sign-in. Guests and inactive, deleting or
verification-required unverified users cannot approve grants. Connected apps
under Settings → Account lists the caller's grants and disconnects only that
user's app access, including approved device codes not yet exchanged.

Access JWTs expire in 15 minutes; refresh tokens rotate with no reuse window and
a 30-day lifetime. The app verifies JWTs locally with its auth-owned keys, exact
issuer/resource and token type, then checks current consent, account and client
state on every v1 request. Each JWT and refresh token binds to the consent's
unique ID, so disconnect is immediate and reconnect cannot revive an old token.
Device approval persists consent before making the code redeemable, and exchange
captures that grant before atomic code consumption. Issuance cannot recreate
consent after a racing disconnect or borrow a later reconnect's grant. Refresh
binding is checked before token issuance and persisted before returning
the replacement. Browser login expiry does not revoke an offline grant; explicit
Disconnect owns that behavior. Native provider consent-edit/delete endpoints are
disabled so they cannot bypass complete grant revocation.

Bearer headers take precedence over cookies and never fall back to a session.
The three API scopes are enforced by the same principal helper as cookie access.
Provider credentials, private/admin/account routes, worker authentication and
browser sessions stay separate. Bearer compute admission uses the approving user,
without charging a hosted client's IP or guest device. Explicit audiobook plan
references from bearer clients additionally require a matching stored owner.

RFC discovery is published at
`/.well-known/oauth-protected-resource/api/v1` and
`/.well-known/oauth-authorization-server/api/auth`; unauthenticated challenges
point to resource metadata. OpenAPI advertises cookie or scoped OAuth access.
The public API reference and OAuth guide explain registration, PKCE, device
polling, refresh, disconnect, limits, issuer changes and migration deployment.

Acceptance evidence (2026-11-01):

- On a disposable stack, visible sign-in and new-account sign-up both continued
  to the signed consent request. The screen showed the actual callback host,
  scopes, Unverified app warning and shared limits. Allow returned a usable
  read-only JWT; Deny returned `access_denied`. Device code checking and explicit
  approval produced a scoped token. Connected apps showed the correct scopes
  and redirect domain; Disconnect immediately rejected access and refresh for
  both flows. The stack and callback receiver were stopped before Playwright.
- Real-handler tests use a migrated SQLite database and the actual provider's
  PKCE, consent, signing, device and refresh implementation. They cover scope
  enforcement, audience/issuer/expiry/signature failures, cookie fallback
  refusal, guest/inactive/client-disable checks, registration policy, user
  isolation, rotation/reuse, offline refresh after browser expiry, signed-query
  tampering and sign-up continuation. Forced interleavings prove device
  exchange cannot recreate consent or borrow a reconnect's grant after
  Disconnect, and late refresh credentials cannot cross grant identities.
- Full Vitest: 1,651 passed across 245 files. Application and worker TypeScript,
  production build, route-error, compute-boundary and install-profile checks
  passed. Documentation production build and OpenAPI TypeScript generation
  passed. Both migration snapshots preserve all existing table definitions and
  add only nine OAuth/device/signing-key tables. The SQLite serialization fix
  needs no additional DDL; schema generation reports no changes.
- The first matrix exposed a new-test transport mistake: token exchange carried
  the browser's cookie without an Origin header and correctly failed CSRF.
  Native-client requests now use an independent cookie-free request context.
  A WebKit return-to-library click also landed while the pre-existing beta
  banner's height animation moved document links. The separate library fix
  reserves its full height while fading opacity. Visible immediate
  return-and-open navigation passed, with the existing assertion unchanged.
- Final complete Playwright: 83 passed in 2.8 minutes, with no failures, skips or
  retries, including both real playback journeys and both OAuth journeys.
  Chromium/WebKit, Firefox policy, 50% workers, timeouts and assertions remain
  unchanged. The matrix reused the immediately preceding production build with
  the same temporary logging configuration as earlier phases. Its explicit
  localhost `BASE_URL` keeps discovery, issuer and resource consistent with the
  browser regardless of the developer's `.env`. Port 3003 and the disposable
  callback port were free after testing.

The OAuth implementation is committed as `28d07c9e`; the independent library
banner fix is `e54360b9`. No production migration, deployment, version bump, tag
or push was performed. Migration 0028 remains an owner-coordinated deployment
step. Next: phase 5 adds the separate MCP resource and stateless HTTP tools.

### Phase 4.5

Hardening from the review of phases 1-4, specified above. No new public capability.
Owner decisions: Stop cancels the shared run and ends every whole-book request on
it; finished requests stay addressable for 7 days; migration 0028 is rewritten in
place with a unique `oauth_consent (user_id, client_id)` index, so local databases
that ran the earlier version must be reset.

- Testing found two defects in the fixes themselves. The default worker timeout had
  landed on the voice preview rather than the JSON request path, so a hung worker
  could still hold the audiobook lock. Pruning read `status` alone, which reports
  `ready` while a run is still changing the audio. Both are fixed and covered.
- The advisory lock, the cleanup statements and the consent index were checked
  against a disposable PostgreSQL 16 container: exclusion, release on failure,
  independent keys, a busy result after 10 seconds, and a refused duplicate consent.
  The committed lock tests stub the pool, so CI does not need a database.
- OpenAPI tests now check real document and audiobook responses against the published
  schemas with a small in-test validator. `lint:route-errors` is unchanged, because
  those schema checks cover the v1 error shape.
- Full Vitest: 1,713 passed across 246 files. Application and worker TypeScript,
  production build, route-error, compute-boundary and install-profile checks passed.
  Schema generation reports no changes for either dialect.
- Final complete Playwright: 85 passed in 3.1 minutes, with no failures or retries,
  adding the signed-out device sign-in journey for both browsers. Port 3003 was free
  before and after.

No production migration, deployment, version bump, tag or push was performed. Next:
phases 4.6 to 4.8, then phase 5.

### Phase 4.6: Account creation and IP handling

All sign-up paths now enforce optional rolling guest/account creation caps in
the user-create hook, using the existing limit buckets. Counters serialize per
hashed IP and account kind, including concurrent requests at the boundary.
Guests default to 10 per guest idle period; accounts to 5 per 30 days. Both caps
default off and skip requests without a known IP. Existing sessions and sign-in
remain available. A capped guest bootstrap goes directly to Sign in without
retrying; sign-up displays the server error.

Session creation replaces IPs with a separately labelled keyed hash. IPv6
addresses group by /64, including canonicalization and mapped IPv4 handling.
Better Auth still sees the incoming IP for request throttling. Account exports
omit session IPs. Migration 0029 clears old raw session values, removes retired
IP/device admission columns and discards their limit buckets. User/site compute
limits remain; device cookies and their route plumbing are removed. Saved
schema-2 policies discard only retired scope rows, preserving enabled states
and remaining user/site values, including policies with only retired usage rows.

Instance settings hide caps when their feature is off and hide all these
controls on desktop. Enabling a cap reveals its prefilled defaults. Guest caps
display the current idle period and link to Tasks when guest cleanup is off.
The privacy policy, consent summary, deployment settings and full seed example
reflect IP hashing and the removed device cookie.

Acceptance evidence (2026-11-02):

- Visible disposable-stack verification confirmed off-by-default toggles,
  revealed defaults of 5 accounts / 30 days and 10 guests / guest idle period,
  and the cleanup-disabled consequence with its Tasks link. Drafts were
  discarded and the stack stopped before the browser matrix.
- Real-handler tests cover both creation caps, existing-account sign-in,
  unknown IPs, IPv6 grouping, hashed session persistence and Better Auth request
  throttling. Real SQL tests cover concurrent rolling counters and exact expiry.
  A saved copy of the old policy proves configured user limits survive removal
  of device/IP rows. Migration coverage preserves sessions while clearing IPs.
- Complete Vitest: 1,719 passed across 247 files. Application/worker TypeScript,
  production build, route-error, compute-boundary and install-profile checks
  passed. Documentation production build passed; schema generation reports no
  further changes for either dialect.
- Complete Playwright: 87 passed in 3.1 minutes, including both real playback
  journeys and the capped-guest journey in Chromium/WebKit, with no failures or
  retries. The first invocation could not launch Chromium under the macOS
  sandbox; the unchanged matrix passed with browser-launch permission. Port
  3003 was free after teardown.

Migration 0029 remains an owner-coordinated production upgrade. No production
migration, deployment, version bump, tag or push was performed. Phase 4.8 is
deferred at the owner's request; phase 5 has not started.

### Phase 4.7: Storage and intake

Migration 0030 adds `document_audio_usage`, one user/document row for segment
audio, timing sidecars and exports. A single SQL aggregation supplies source
document bytes, audio bytes and their total to storage settings, the admin user
directory and caps. Shared derived artifacts are excluded. Library-wide scans
and their summary helpers are removed; document settings and scoped audio
deletion retain their one-document breakdown scans. Orphaned audio stays charged
until cleanup removes it; zero-byte rows preserve the deletion fence.

The worker measures the affected document during generation, at run completion
and after audio deletion. Reports use the existing credential broker token at
`/api/internal/compute/storage`. The app issues revisions before measurement;
clearing takes a short lease and a newer revision before deleting objects.
Older reports cannot overwrite the cleared total, and report updates cannot
recreate a deleted user or usage row. The worker scans paged listings in bounded
memory and never queries SQL. Settings pages only read SQL.

Repair storage usage is a durable scheduled worker task. Its first run backfills
all existing users; later runs repair users with account, session, document or
audio activity in the last seven days. It discovers stored audio and includes
ledger-only scopes so missing objects are repaired to zero. Successful worker
completion now retains the scheduled cursor; failed repair starts a full pass
again. No new polling loop is added to the reader.

Storage caps are separate for accounts, guests and the shared guest pool. All
default off; enabling reveals 10,240 MB/account, 1,024 MB/guest or 10,240 MB for
the pool. Upload preparation checks the projected total. Registration checks
again in a transaction, with a user row lock and a separate PostgreSQL advisory
lock for the guest pool; SQLite serializes through BEGIN IMMEDIATE. This prevents
concurrent prepared uploads from bypassing the cap.

Uncached synthesis checks storage at the character-charge boundary even when
daily character limits are disabled. Periodic measurements and in-flight
segments mean audio can cross the byte threshold before stopping in the existing
usage-limited state. Cached playback remains available. The stored limit reason
reaches audiobook status and the existing quota banner. Blocked upload/import
and generation views link to Storage, and guests can create an account when
sign-ups are open. Both audio cleanup views refresh storage and quota state.

`document_intake` is an additive, app-owned UTC-day file allowance with no worker
execution block. It defaults off with 10 files/guest and 100 files/account ready
to enable. File preparation, text and URL imports count once, including failed
imports. URL and Gutenberg imports charge before fetching; staging does not
charge them again. Existing upload status/finalization reads do not consume
another file. The new controls follow the opt-in pattern and stay hidden on
desktop or when their parent feature is off.

Acceptance evidence (2026-11-02):

- A disposable local stack visibly verified the storage breakdown and unsaved
  cap/file defaults. With a 1 MB guest cap and character limits off, a real
  24-segment export paused at 8/24 with a guest-storage message and working
  Storage/Create an account links. Its approximately 1.9 MB included segments
  already in flight. Cached audio still played. Delete all audio left the
  document's 4.9 KB and reported 0 B of audio. The stack was stopped.
- Real-SQL tests cover shared totals, owner isolation, orphaned audio, concurrent
  account/guest-pool caps, daily intake before URL fetching, idempotent charges,
  storage enforcement with characters off, late-report fencing, account deletion,
  broker authentication and API activity without a browser session. Worker tests
  cover scoped measurement, sidecars/exports, clear fencing, interrupted deletion,
  throttling and backfill discovery. Durable-task tests preserve the repair cursor.
- A disposable PostgreSQL 16 database passed migration 0030, source/audio totals,
  concurrent account and shared-pool cap enforcement, maintenance selection and
  late-report fencing. Its temporary test and container were removed. SQLite and
  PostgreSQL schema generation report no further changes.
- Complete Vitest: 1,733 passed across 249 files. Application/worker TypeScript,
  production build, route-error, compute-boundary and install-profile checks
  passed. Documentation production build passed, and worker OpenAPI/types were
  regenerated for the maintenance task.
- The first browser matrix found a deterministic new-test locator error:
  Chromium/WebKit expose the native summary without a button role. Its action
  now targets the exact visible label; all value assertions remain unchanged.
- Final complete Playwright: 89 passed in 3.2 minutes with no failures or retries,
  including both consolidated real playback journeys. They verify positive
  measured audio, a matching source-plus-audio total, zero audio after clearing,
  preserved document bytes and refreshed quota state. Both browsers also cover
  the new cap/file controls and blocked-guest Storage/Create an account links.
  Port 3003 was free after teardown.

Migration 0030 and the initial audio backfill remain owner-coordinated production
upgrade steps. No production migration, deployment, version bump, tag or push was
performed. Phase 4.8 remains deferred; phase 5 has not started.

### Phase 4.8 guest retention notice

Implemented on 2026-11-02.

- `/api/user/state/onboarding` returns `guestRetentionDays`: the idle period for a guest
  while "Delete idle guest accounts" is on and guests are allowed, otherwise null. It is
  read only for guests, so accounts pay no extra query.
- The onboarding flow shows the notice after privacy, with a direct way to create an
  account. Migration 0031 adds nullable `user_onboarding.guest_retention_seen_days` beside
  the other onboarding state, because browser storage is limited to theme and analytics
  consent. The notice returns if the period gets shorter than the one the guest saw.
- Claim audit: `claimAnonymousData` moves documents, progress, bookmarks, document settings,
  folders, preferences and cloned voices. Generated audio and audiobook files stay under the
  guest's storage scope and are deleted with the guest. The notice, the guest Account panel
  and the privacy policy now say so; the Account panel previously promised that all data
  transfers.
- The privacy policy states the rule and not a number, because the operator sets the period
  and the page should not depend on the database.

### Phase 4.9 single migration

Implemented on 2026-11-02. `main` stops at migration 0026, so the branch's unshipped 0027 to
0031 were deleted and regenerated as one `0027_public_api` for both dialects, with the
hand-written session IP and limit bucket cleanup appended. A local database that ran the
earlier versions must be reset. Later phases add their own migrations after 0027.

Acceptance: the regenerated snapshots match the old 0031 snapshots in both dialects, and
every old statement is in the new file. Applying the old and new chains from empty gave
identical `sqlite_master` contents and an empty `pg_dump --schema-only` diff on PostgreSQL 16.

### Phase 5: MCP

Implemented on 2026-11-02.

- `/api/mcp` is a stateless streamable HTTP endpoint built with `@modelcontextprotocol/server`
  2.4.0. It serves the 2026-07-28 protocol and stateless legacy traffic with the same
  tools: `list_documents`, `add_document`, `list_providers`, `list_voices`,
  `create_audiobook` and `get_audiobook`. The tools call the same shared logic as `/api/v1`.
- MCP is its own OAuth audience, `BASE_URL/api/mcp`, with its own protected resource metadata.
  A token for `/api/v1` is rejected here and the reverse. The endpoint never accepts a cookie.
- `@better-auth/cimd` adds Client ID Metadata Documents beside DCR, under the one
  `allowOAuthClientRegistration` switch. Consent and Connected apps show the verified domain,
  or "Unverified app".
- The re-consent cutoffs are documented in `docs-site/docs/reference/mcp.md`.
- After the first desktop client connected, `create_audiobook`
  and the v1 audiobook body accept `provider` and `model` beside `voice`. A named provider
  uses its own defaults: saved voices, speeds, options and instructions apply only to the
  saved provider and model. `showAllProviderModels` still limits the model. A voice that is
  not in a static catalogue, or a clone from another provider or model, is rejected at once.
- `GET /api/v1/providers` lists enabled providers and their allowed models, and MCP's
  `list_providers` returns the same data. v1 and MCP voice lists share one implementation,
  with catalogue names and the caller's clones for that provider and model. Clone summaries
  come from object metadata through HEAD requests, so samples are not downloaded, and only
  providers that can speak a clone look them up. A storage failure leaves the catalogue
  listed. The web picker keeps its own clone library.
- Voice names now come from the catalogue. They had repeated the ID, so Fish Audio showed
  IDs instead of names.
- Consent and device approval were simplified and show the signed-in account with Switch
  account. A device link checks its code automatically. `AuthCard` now frames every sign-in,
  account and consent screen.

The Playwright matrix also exposed a bug in the onboarding flow, unrelated to MCP.
`PrivacyModal` awaited the PATCH and its refetch, then called `onAccept`, which closed
whichever modal was open and set the leaving-modal guard. When that landed after privacy's
leave transition, it closed the next step and left the guard stuck, because no `afterLeave`
would clear it, so later steps never opened. A slow network makes this happen every time. The
fix deletes `onAccept`: the flow already reacts to the optimistic consent, and a failed save
rolls back and reopens privacy. The new `guest-retention` test delays the PATCH by a second. It
failed 3 of 3 runs without the fix and, together with the existing journey, passed 40 of 40
with it.

Acceptance:

- 1748 Vitest tests and 93 local Playwright cases passed, with both type checks and the
  route-error, compute-boundary and install-profile checks.
- MCP Inspector 2.13.0 against a disposable local stack completed the OAuth flow from the 401
  through protected resource metadata, DCR, sign-in, consent and token. It listed the
  tools, five at that point; added a document from text and from a URL; listed voices from a real Supertonic
  server; and created an audiobook, where a repeat call returned the same id, through to
  ready. Passing both URL and text returned an `isError` result. `webUrl` opened the document.
- Antigravity, a desktop client, connected to a local instance, signed in through OAuth and
  listed voices.

Not covered yet:

- Inspector connected on the legacy path, so the 2026-07-28 protocol is covered by Vitest only.
- No client has generated an audiobook with a provider other than the saved one.
- Hosted connectors need a public HTTPS address, so they wait for final verification.
