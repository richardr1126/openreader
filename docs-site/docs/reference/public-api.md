---
title: Public API
description: The v1 library and audiobook API, its authentication and asynchronous workflows.
---

OpenReader's web app uses the same `/api/v1` document, folder, voice and audiobook
routes available to other clients. Each instance publishes its machine-readable
specification at **`/api/v1/openapi.json`**. Resolve relative resource URLs against
the instance's origin, not against `/api/v1`.

## Authentication

The API accepts an existing Better Auth **session cookie**. Sign in through
the instance normally. Browsers send that cookie automatically. Local scripts can
use a cookie jar for their own session; keep that file private. Guest sessions can
access only their own library and remain subject to guest limits.

Third-party clients use [OAuth](./oauth) with authorization code and S256 PKCE, or
the device flow. Send the resulting access token as `Authorization: Bearer TOKEN`.
Each token carries only the scopes approved by the user. A bearer header takes
precedence over cookies; an invalid token never falls back to a browser session.
Other `Authorization` schemes, such as a reverse proxy's Basic credentials, are
ignored.
Personal access tokens are not available. Assistants can use the separate
[MCP endpoint](./mcp).
Provider API keys are configured by the administrator; they are never client API
credentials. The API does not accept a provider key in place of a session.

Cookie-authenticated writes must come from the same origin or a configured trusted
origin. There is no general cross-origin browser API. The documented scopes are
`documents:read`, `documents:write` and `audio:generate`; an existing web session
has all three. OAuth clients request the smallest set they need. `offline_access`
additionally requests a rotating refresh token. Guests cannot approve OAuth access.

OAuth tokens work only on `/api/v1`, for this instance's exact resource URL. They
cannot administer the instance, change provider credentials or manage accounts.
Disconnect an app in **Settings → Account → Connected apps** to revoke its access
immediately. Third-party requests share the user's existing compute limits.

`GET /api/v1/me` returns the session's ID, guest flag, scopes and `computeLimits`.
The latter describes the current binding TTS character quota, including remaining
characters and its reset timestamp. It does not expose internal bucket identifiers
or provider configuration. Admission limits for conversion, parsing or assembly
are also enforced and can return `429` independently of that character quota.
When storage blocks new generation, `computeLimits.storageLimit` explains which
storage cap was reached, including when daily character limits are off. Uploads
and URL/text imports also share the user's daily file allowance. Storage and
guest-pool caps apply equally to browser and OAuth callers; cached audio is kept.

## Documents

Create a document from text:

```bash
curl --cookie cookies.txt \
  -H 'Content-Type: application/json' \
  --data '{"name":"notes.md","source":{"type":"text","text":"# Notes\n\nA document to read."}}' \
  https://reader.example/api/v1/documents
```

For a web page, use `{"source":{"type":"url","url":"https://example.com/article"}}`.
The server fetches public HTTP(S) pages, checks redirect destinations and extracts
readable Markdown. It cannot see pages available only in your logged-in browser.
Private-network destinations are blocked. HTML downloads and inline text imports
are limited to 2 MB; JSON document control messages are limited to 3 MB.

Creation accepts an optional `folderId`. Text imports can also supply `author`
and `language`. A supplied `name` must include a text or Markdown extension for
text sources; web imports produce Markdown. The resulting ID is the SHA-256 of
the canonical file. Reimporting the same bytes reuses that identity.

Successful registration returns `201`, a `Location` header and the document.
`GET /api/v1/documents/{id}` adds preparation status, `operationId`, `error`,
`fileUrl` and `webUrl` to its metadata. Status reads do not open the reader, update
recent activity, create playback plans or start parsing.

| Status | Meaning |
| --- | --- |
| `ready` | The document can be read and used for audio. |
| `not_started` | A PDF has not been parsed yet. Opening it or requesting an audiobook starts parsing. |
| `processing` | A PDF is being parsed. |
| `failed` | Parsing failed; `error` explains why. |
| `unknown` | The compute worker could not be reached. Read the status again later. |

| Operation | Route |
| --- | --- |
| List/search | `GET /api/v1/documents` |
| Read metadata and status | `GET /api/v1/documents/{id}` |
| Rename or move | `PATCH /api/v1/documents/{id}` with `name` and/or `folderId` |
| Delete | `DELETE /api/v1/documents/{id}` |
| Read canonical file | `GET /api/v1/documents/{id}/file` |
| Move selected documents | `PATCH /api/v1/documents` with `ids` and `folderId` |
| Delete selected documents | `DELETE /api/v1/documents?ids=id1,id2` |

Lists return `{ "data": [...], "nextCursor": "..." }`; keep requesting the
returned cursor until it is `null`. `limit` defaults to 100 and cannot exceed
200. Documents are ordered by ID. `q` is a literal, case-insensitive filename
substring. `folderId=` selects unfiled documents; omitting it selects all folders.
`ids` selects up to 200 comma-separated IDs. Bulk moves and deletes also accept
at most 200 IDs. Deletion always requires explicit IDs. Setting `folderId` to
`null` moves a document out of its folder. Renaming or moving does not invalidate
the document's audio or change its version.

## File uploads and DOCX

1. `POST /api/v1/uploads` with `name` and `size` (exact bytes, at least 1).
   Optional fields are `lastModified` (Unix milliseconds), `author` and `language`.
   The file's content type comes from its extension.
2. PUT the raw file to the returned `url`, with **every returned header**. The URL
   may be a signed storage URL or a same-origin proxy URL. Use the descriptor's
   `expiresAt` and prepare another upload if its transfer URL has expired.
3. `POST /api/v1/documents` with
   `{"source":{"type":"upload","uploadId":"..."}}` and optional `folderId`.

Files are subject to the instance's configured maximum upload size. Transfers
must match their declared length, and canonical bytes are verified before
registration. Pending uploads expire after 24 hours. Signed transfer URLs expire
after five minutes; proxy descriptors use the pending-upload lifetime. Storage
transport and CORS requirements are described in [Object and blob storage](../configure/object-blob-storage).

DOCX is converted to PDF by the compute worker, so without a worker the commit
returns `503 COMPUTE_WORKER_REQUIRED`. Until conversion finishes,
creation returns **`202` with an upload resource**, rather than inventing a
temporary document ID. Use its `statusUrl` to read progress or its `eventsUrl` to
observe SSE snapshots, then read `statusUrl` after completion. That read verifies
and registers the canonical PDF and returns it as `document`. Conversion can run
with the tab closed, but registration still requires the status read. `failed`
uploads include an error message.

The upload resource uses `pending`, `processing`, `ready` and `failed` status.
Its `ready` means the file is registered; the returned PDF document may still
have `status: "not_started"` or `"processing"` until PDF parsing finishes. A
compute limit or worker outage at that moment does not fail the commit; the
document is registered and parses later. A converted DOCX's file URL
serves the resulting PDF.

## Folders and voices

`GET /api/v1/folders` returns the same paginated list envelope, ordered by
`position`, creation time and ID. Cursors are opaque; reuse them unchanged.
`POST /api/v1/folders` takes `name`, an optional caller-selected `id`, and optional
`documentIds` (at most 200) to move into the new folder atomically. A name is
trimmed and limited to 200 characters. Folder IDs are 1–100 letters, digits or
hyphens; omit `id` to generate a UUID.

`PATCH /api/v1/folders/{id}` accepts `name` and/or integer `position`.
`DELETE /api/v1/folders/{id}` removes one folder;
`DELETE /api/v1/folders` removes all of the caller's folders. **Both keep the
documents**, moving them to the unfiled library. Deletes return `204` without a
body. Folder write bodies are limited to 64 KB.

`GET /api/v1/providers` returns `data` and `nextCursor: null`, with one entry per
enabled speech provider: `id`, `name`, `type`, `defaultModel`, `selected`,
`selectedModel`, `models: [{id, name}]`, and `acceptsCustomModel`. Keys and base URLs
are never included.

`GET /api/v1/voices` returns `data: [{id, name}]`, `nextCursor: null`, and the
resolved `provider` and `model`. Without selection parameters, it follows the
caller's saved speech provider/model, then the instance default. Optional
`provider` (a configured shared-provider slug) and `model` query parameters select
a different catalogue, subject to the administrator's model policy. The list includes
the caller's cloned voices for that provider and model; their IDs start with `clone:`.
`status` is `listed` when the provider named the voices, `defaults` when it has no
voice list and these are its standard voices, and `unreachable` when it did not answer,
so the voices are unconfirmed.

`GET /api/v1/documents/{id}/cached-voices` lists the voices the document already has
audio for, newest first: `provider`, `model`, `voice`, `name`, the `modelSpeed` the
audio was made at, its `segments` and its `durationMs` at 1x. An audiobook request
naming that provider, model, voice and `modelSpeed` reuses the audio. Voices whose
audio no longer matches the document's reading settings, or whose provider is
disabled, are left out.

Voice IDs are the existing **provider-native strings**, stable within that
provider and model. They are not global voice names. Use a voice from the same
provider/model as the audiobook settings. Listing another catalogue does not
change saved settings. Personal voice recordings, previews, provider management
and live playback remain private app features.

## Audiobooks

```bash
curl --cookie cookies.txt \
  -H 'Content-Type: application/json' \
  --data '{"format":"mp3","speed":1}' \
  https://reader.example/api/v1/documents/DOCUMENT_ID/audiobooks
```

The request uses the document's saved settings. Optional `provider` and `model` select
any enabled provider and a model the instance allows. Saved voices and options apply
only to the saved provider and model; any other choice starts from that provider's
defaults. The saved voice speed applies to any model that has one, and `modelSpeed`
(0.5 to 3) replaces it. Unlike `speed`, it changes the generated audio. Optional `voice`
selects a voice from that provider and model, including a `clone:` voice. A disabled or
unknown provider, or a voice the provider does not list, returns `400`; a provider that
cannot be reached to check the voice returns `503`. `speed` ranges from 0.5 to 3 and is rounded to two decimals,
and `format` is `mp3` (default) or `m4b`. Other values return `400`. Advanced explicit `settings` and planning references used by
the web app are described in the specification; ordinary clients can omit them.

The response is `200` when the matching file is ready, otherwise `202` with its
status and ID. A repeated request with matching document version, settings,
format, speed and chapter reuses the same audiobook. Read
`GET /api/v1/documents/{id}/audiobooks/{audiobookId}` until `downloadUrl` is
present, then follow it. `webUrl` opens the reader in the normal app. `webDownloadUrl`,
present with `downloadUrl`, is a page for a person to open in a browser: it starts
the download, or offers to sign in or switch account if that browser lacks access.

Signed-in whole-book requests continue through assembly after the tab closes.
Guest requests advance only on the guest's own requests. If an unparsed PDF
returns `409 DOCUMENT_PREPARING`, retry after `retryAfterMs`; a POST starts the
parse, while a lookup only reports it. A compile held back by admission limits
reports `waiting` and can recover on a later status read or completion signal.
Usage-limited, failed or interrupted generation needs an explicit new POST to
resume; status reads do not restart failed generation.

Only a caller with `audio:generate` advances a request when reading it. With
`documents:read` alone, GET and lookup observe and never start work.

A request stays addressable for **seven days** after its last POST and until it
has finished or been cancelled, then GET returns `404`. The audio and any finished file are not
affected: a new POST with the same settings finds them again.

Stop with `DELETE /api/v1/documents/{id}/audiobooks/{audiobookId}`. Generated
audio remains cached, and the request reports `status: "cancelled"`. Formats and
speeds of the same settings share one generation run, so stopping that run also
cancels the other whole-book requests on it. POST again to resume any of them.

If the speech provider fails several segments in a row, generation stops with
`PROVIDER_UNAVAILABLE` or `PROVIDER_REJECTED` in `generation.issue` rather than
skipping the rest of the book. POST again once the provider is back.
`retrySkipped: true` retries skipped whole-book segments. `chapter` is a
zero-based chapter index for assembling already-settled audio; it does not start
generation, and chapter Stop is rejected.

The spec also covers the app's settings lookup, authorized operation SSE and
file routes. SSE connections are bounded to 300 seconds; reconnect as needed.
External clients may poll status. The reader continues using its existing
event-driven private playback protocol.

## Errors and downloads

Errors use this shape:

```json
{"error":{"code":"DOCUMENT_PREPARING","message":"This PDF is still being prepared.","retryAfterMs":5000}}
```

`429` includes a `Retry-After` header in seconds. Worker unavailability normally
returns `503` with a retry hint, as does `AUDIOBOOK_BUSY` when another request for
the same document's audiobooks is still running. IDs and operation streams are checked against the
caller; identical document content does not grant access to another user's
uploads, events or audiobooks.

Files are always sent as attachments, with a content type chosen from the file
name, so a document cannot run as a page on the instance's origin. In proxy mode,
file routes return bytes. In presigned mode, canonical document
files return `307` and audiobook files return `303`, both pointing to short-lived
storage URLs. Follow redirects and keep the resource URL for later use, rather
than saving the signed destination. The browser transport is described in
[Object and blob storage](../configure/object-blob-storage).
