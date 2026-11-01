# Public API refactor

Status: accepted; phase 1 is implemented, later phases are not.

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

## Current state

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

| Area | Today | After |
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
| `GET`, `POST /folders` | List or create folders |
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

Add `@better-auth/oauth-provider`. Version 1.7.15 requires Better Auth 1.7.15;
the repo is on 1.7.14. Its published types show dynamic client registration, the
device code grant and a protected-resource metadata helper. These have not been
exercised yet.

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
so. Requests from a hosted MCP client arrive from that vendor's IP, so check that limits
key on the user. A per-app limit can be added if a runaway client becomes a real problem.

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

### Phase 5: MCP

Add `/api/mcp` as a stateless streamable HTTP endpoint on the same shared logic.
Start with `list_documents`, `add_document`, `list_voices`, `create_audiobook` and
`get_audiobook`.

- Tools return a status at once and never wait for an audiobook to finish.
- Tools return `webUrl` for the user to open, because a link that needs a bearer
  token cannot be clicked in chat.
- No local MCP package is needed at first, since OAuth handles sign-in.

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
9. **Third-party usage:** apps share the user's limits, with no per-app limit at first.

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
commit, push or production migration was performed. Migration 0027 still needs the
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
