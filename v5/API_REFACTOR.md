# Public API refactor

Status: accepted; nothing here is implemented yet.

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
| `GET /documents/{id}` | Details and status: `processing`, `ready` or `failed` |
| `PATCH /documents/{id}` | Rename or move |
| `DELETE /documents/{id}` | Delete |
| `GET /documents/{id}/file` | Download the original file |
| `GET /voices` | List available voices with stable IDs |
| `POST /documents/{id}/audiobooks` | Start an audiobook, or return the matching existing one |
| `GET /documents/{id}/audiobooks/{audiobookId}` | Status, progress and download link |
| `DELETE /documents/{id}/audiobooks/{audiobookId}` | Stop generation |
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

Nothing has landed yet.
