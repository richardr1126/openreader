# Playback and Derived Media Architecture

This is the current architecture for TTS playback and adjacent derived-media
work across the browser client, Next.js app on Vercel, and compute worker on the
Railway container. It reflects the cursor/session split, the move from the
mutable segment index/claim store to per-ordinal sidecars, the compute-worker API
hard cut, and the remaining Next/worker ownership debt.

---

## Core Rules

Classify playback state by `durability x write-frequency`, and do not use CAS in
the playback path.

| State | Home | Write model |
|---|---|---|
| Playback plan | S3, immutable plan object | write once |
| Segment audio | S3, content-addressed CBR MP3 under `tts_playback_segments_audio_v1/` | idempotent put |
| Segment duration/alignment/status | S3, one sidecar per plan ordinal | put to unique key |
| Session record | JetStream KV, `tts_playback.session.*` | plain `put` |
| Cursor/playhead | JetStream KV, `tts_playback.cursor.*` | plain `put`, last-write-wins |
| Job queue | JetStream stream, `compute_jobs` subjects | small durable work messages |
| Operation index/state | JetStream KV, `op_index.*` / `op_state.*` | CAS only for op claiming/state machine |
| SSE events | JetStream stream, `compute_events` subjects | replayable operation snapshots |
| Large manifests/artifacts | S3/object storage | write once or idempotent put |

The important invariant is that hot cursor updates never rewrite the worker-owned
session record. Cursor writes happen on their own KV key, so a per-second browser
heartbeat, audio-range re-anchor, and worker status update cannot collide on one
revision. `kv.update(...revision)` should not appear in playback storage.

Classify API ownership by `request duration x compute/memory/streaming cost`.
Next.js routes run under Vercel's request-duration model and should own
authentication, scope resolution, quota/rate checks, database metadata,
presigned URL issuance, short worker job creation/resolution, and short JSON
snapshots. The Railway compute worker should own any work that can stream for
minutes, wait on provider/model generation, transcode, render, parse, convert,
package archives, or scan large object sets.

The worker should not become a SQL application server. SQL remains the Next.js
control-plane database for users, auth, document metadata, folders, admin UI,
quotas, rate/concurrency ledgers, and account records. Worker-owned jobs should
persist job identity, operation state, session state, and progress in
NATS/JetStream, and persist large inputs/outputs/manifests in object storage.
Job messages should carry canonical scope, object keys, settings hashes,
operation ids, and small options; they should not carry large blobs or require
the worker to query app tables. The current narrow exception is read-only worker
access to `admin_providers` for server-managed TTS provider credentials. Do not
expand that exception for previews, conversion, exports, document metadata, or
user/account data.

---

## Components

```
[Browser client] --HTTP--> [Next.js API routes] --HTTP--> [Compute worker]
  <audio> element             auth + control plane      Fastify routes
  projection loop             presigned URLs            JetStream KV/streams
  scrubber/seek               bounded SSE proxies       S3 artifacts
```

The Next.js app is not the durable media worker. It remains the authenticated
control plane for browser-owned requests: it validates users, resolves document
and storage scope, applies quota/rate policy, mints signed worker/public object
URLs, creates or resolves worker jobs, and returns short snapshots. Bounded SSE
proxies are acceptable because the browser reconnects with event ids and the
worker owns the long-lived stream source.

The compute worker owns durable playback state, artifact layout, generation, and
stream construction. It also owns the target home for long-running derived media
jobs that currently still leak into Next routes: audiobook packaging/transcoding,
document preview rendering, DOCX conversion, and large account export packaging.
Those remaining Next routes should become resolve/create/download control-plane
routes, not Vercel-hosted compute routes. Moving a job to the worker means its
queue/progress/state moves to NATS/JetStream and its durable files move to object
storage; it does not mean the worker starts reading or writing SQL ownership
tables.

That split is still too blurry for EPUB rendering/highlight behavior. The worker
is the authority for the durable plan and absolute ordinals, while the client
still derives rendered EPUB windows and keeps a viewport anchor for navigation.
Playback start no longer branches across EPUB CFI, viewport locator, selected
locator, text, segment key, or current index. The canonical worker plan is always
the playback identity source, and starting audio requires one absolute
worker-plan ordinal.

### Next API Surface

Current Next route ownership is intentionally mixed only where Vercel hosting
patterns require it:

- Auth, account, admin, user-state, document metadata, folders, runtime config,
  TTS provider metadata, and rate-limit status are ordinary short JSON routes and
  stay in Next.
- Document upload/download/preview paths must use S3 presigned URLs. Do not keep
  fallback proxy routes for old browsers, local object reads, or degraded object
  storage behavior; storage is required and byte proxy fallbacks buffer request
  or object bodies inside Vercel functions.
- PDF parse and TTS playback generation are worker-owned jobs. Next creates or
  resolves deterministic jobs, returns short snapshots, and proxies operation
  SSE only as a bounded reconnectable stream. Completed parsed PDF artifacts
  should be delivered through signed object URLs; same-origin parsed JSON byte
  proxying is route ownership debt to remove.
- TTS live playback audio should use the signed Railway worker URL directly.
  Same-origin Next audio byte proxy routes are route ownership debt to remove;
  normal audiobook downloads use worker-owned export artifacts plus same-origin
  control-plane authorization and object-storage presigning.
- Scheduled tasks may remain in Next while they are bounded maintenance work
  below Vercel's limit. They must not grow into parse/TTS/render/transcode/export
  jobs.

Current known ownership debt:

- None. The pre-v5 route debt (same-origin MP3 byte proxy, parsed JSON byte
  responses, blob fallback proxies) was removed by Step 17, and the export
  storage-layout and retention debt was closed by Step 20.

---

## Durable State

### Session and Cursor KV

`createTtsPlaybackKvStore` writes two keys for a session:

- `tts_playback.session.<hash(sessionId)>`: worker-owned session metadata such as
  status, settings, plan key, generation start, expiry, and last error.
- `tts_playback.cursor.<hash(sessionId)>`: hot playhead state,
  `cursorOrdinal` and `cursorUpdatedAt`.

`getSession` reads the session record and overlays the cursor key before returning
the row. `putSession` initializes both keys. `patchSession` strips cursor fields
out of record patches and writes them to the cursor key; a cursor-only patch does
not rewrite the session record. `updateCursor` is a single plain `put` to the
cursor key.

### Plan

The playback plan is immutable and stored in S3. It provides the ordered segment
list, ordinals, text, locators, and segment keys used by generation, streaming,
timeline, highlighting, and sidebar readers. A worker-plan ordinal is the only
valid playback-start identity. Reader locators/CFIs can help the UI navigate and
map visible DOM ranges, but they must not be competing playback-start inputs once
the canonical plan exists.

### Segment Audio

Segment audio is content-addressed by text plus voice/model/settings/language and
segmentation inputs. The deterministic key is the source of deduplication. If two
workers synthesize the same segment concurrently, they write the same bytes to the
same key; that is wasteful but correct.

Audio is already normalized to a single **CBR** MP3 profile before storage —
`normalizeToMp3` re-encodes every segment to `STREAM_AUDIO_PROFILE` (44.1 kHz mono,
128 kbps CBR, Xing header stripped) in `packages/tts/src/audio-format.ts`, which is
what makes the whole-document stream byte↔time linear and seekable. The encoding is
not changing.

Playback stores generated stream audio in its own content-addressed prefix. It no
longer writes the inherited `tts_segments_v2/` prefix used by the pre-refactor
system, so the v5 artifact set is self-contained and `tts_segments_v2/` can be
dropped wholesale during decommission:

`tts_playback_segments_audio_v1/[ns/<ns>/]users/<userId>/docs/<documentId>/<version>/<settingsHash>/<audioContentHash>.mp3`

This sits beside the sidecar prefix rather than inside it on purpose: audio is
keyed by content (`settingsHash + audioContentHash`) for cross-ordinal/session
dedup, while sidecars are keyed per ordinal. The audio content hash is a worker
implementation detail, not a playback cursor/start identity and not a persisted
sidecar or client row field. The playback plan, audio, and sidecar prefixes are
v5-owned derived artifacts and are cleared together on clear-cache so a stale or
malformed immutable plan cannot survive while regenerated audio uses a new view
of the document.

### Segment Sidecars

The old mutable aggregate index and KV claim store are gone. Each segment writes
one sidecar object:

`tts_playback_segments_v1/users/<userHash>/docs/<documentId>/<version>/<settingsHash>/segments/<ordinal>.json`

The sidecar stores duration, alignment, audio key, status, updated time, and the
segment identity fields. It is keyed by plan ordinal, not segment id, so readers
can address it directly from the plan without recomputing audio hashes or listing
S3. Because each ordinal has its own object, there is no read-merge-write race.

Completed sidecars are treated as immutable and cached by the worker process.
Missing or non-completed sidecars are re-read so new generation progress from this
or another worker is discovered.

---

## Worker Flows

### Create/Start Playback Target

1. The client ensures the canonical worker plan is loaded.
2. The client maps the selected/highlighted UI state to exactly one worker-plan
   ordinal from that plan.
3. The client asks the Next proxy for a playback session with that ordinal.
4. The compute worker validates the ordinal against the immutable plan and uses it
   as `generationStartOrdinal`.
5. The worker writes the session record and cursor key with plain `put`.
6. A JetStream operation is queued for generation.
7. The generation job patches non-cursor session fields such as status and
   generation start with plain `put`.

There is no alternate playback-start path through EPUB CFI, viewport locator,
segment text, segment key, or page-start anchor. If the client cannot map the
requested start to a worker-plan ordinal, it must not start audio. It must first
load/fix the plan-backed mapping, then create the playback session from that
ordinal.

### Generate Segments

For each planned segment:

1. Build the deterministic content-addressed audio key.
2. Read the per-ordinal sidecar.
3. Check `objectExists(audioKey)` as the durable source of "audio already exists".
4. If audio exists, rebuild or self-heal the sidecar when duration/alignment is
   missing, using the stored audio when available.
5. If a terminal error sidecar exists and no audio exists, leave the gap instead
   of repeatedly hammering the provider.
6. Otherwise synthesize, write audio, compute duration/alignment, and write the
   sidecar.

There are no segment claims and no completed-claim stale takeover path. Object
storage is the correctness boundary.

### Stream Audio and Layout

Timeline and seek-layout responses remain whole-document grids. The audio byte
stream is a session-relative suffix whose byte/time zero is the session's
`generationStartOrdinal` (or an explicitly validated `fromOrdinal` when a
backward seek rebases the stream). This keeps startup identical for EPUB, PDF,
and HTML: the browser plays from media time zero and never has to load a long
synthetic prefix before attempting a deep initial seek.

The client retains one stream-base time and translates between session-relative
`audio.currentTime` and whole-document UI time. A seek within the current suffix
is an ordinary media seek. A seek before the suffix rebases the same session at
the target plan ordinal; it does not introduce a reader-specific restart path.

The audio route builds the suffix CBR layout from the canonical plan plus
completed sidecars. Generated segments use exact probed duration. Missing
segments are represented by frame-aligned silence estimates, so byte-range
seeking can target ungenerated regions without cutting a segment in half.

Readiness is derived from sidecars:

- Single-ordinal reads are used by the stream wait loop.
- Timeline and seek-layout readers use a bounded scan from the start of the plan
  through `max(highestCachedCompletedOrdinal, cursorOrdinal) + 64`.
- Reads are batched in groups of 32.
- Completed sidecars are cached forever within an LRU-ish scope cache capped at 8
  document/settings scopes.
- The non-hot `/segments` listing reads all plan ordinals so it can return the full
  completed set.

### Cursor Updates

Cursor updates are hints, not durable truth. The browser heartbeat and worker
stream re-anchors can both write the cursor key. Last write wins, which is the
right behavior for "where playback probably is now".

---

## Client State

Client playback state is split across three owners.

`TTSContext` is the app-level coordinator. It exposes playback state/actions and
owns document/config inputs that are outside the media controller:

- Playback plan request construction through the Next proxy.
- Settings mutations for voice, speed, provider, language, and PDF skip kinds.
- Segment/word highlight state and current document anchor.
- EPUB cursor-follow navigation guards.

`useTtsPlaybackModel` is the single client model for worker-plan state:

- The normalized worker playback plan.
- Canonical playback segments derived from that plan.
- Derived sentence strings and current row.
- The selected worker-plan ordinal.
- The seek layout returned by the worker.

Array indexes are derived display/navigation values only. They are not playback
identity and are not serialized into worker requests.

`useTtsPlayback` is the media controller. It owns:

- The unlocked `<audio>` element ref.
- Playback phase state.
- Playback session/timeline refs.
- Playback session creation through the Next proxy.
- Audio event wiring.
- Seek and resync logic for generated and not-yet-generated regions.
- Timeline refresh and playback projection from `audio.currentTime`.
- Foreground SSE sync, cursor heartbeat, visibility resync, and projection loop.
- The in-flight playback guard and false-to-true playback driver edge.

For EPUB specifically, the client owns only reader rendering/navigation concerns:

- It builds rendered text maps for the visible page.
- It records a stable spine anchor for visible highlight mapping and CFI
  navigation.
- It maps the current worker-plan segment to visible ranges; it does not
  materialize client-owned playback segments.
- It paints those ranges with the shared non-mutating DOM Range painter. EPUB.js
  CFI annotations are a compatibility fallback, not the per-word hot path.
- It does not use CFI, viewport locator, page-start anchor, text, segment key, or
  array index as playback-start identity.

---

## Invariants

- No CAS (`kv.update`) in playback storage.
- Cursor state lives on its own KV key and is overlaid onto sessions on read.
- Cursor writes are plain `put`, last-write-wins.
- Session record patches must not rewrite cursor-only updates into the session
  record.
- Segment audio is content-addressed; sidecars point at audio and carry metadata.
- There is no mutable aggregate segment index.
- There is no KV segment claim store.
- Stream/timeline/seek-layout readers derive readiness from per-ordinal sidecars.
- Seek intent uses whole-document time and plan ordinals; stream byte ranges are
  relative to the active ordinal suffix and do not split segments.
- Audio streams start at a validated plan ordinal; media time is translated to
  whole-document time by one shared client stream base for every reader type.
- The browser projects UI state from `audio.currentTime`; highlights do not drive
  audio time.
- Playback start requires a canonical worker-plan ordinal.
- EPUB CFI, viewport locator, page-start anchor, segment text, and segment key are
  not playback-start inputs.
- The worker validates the requested ordinal against the canonical plan and stores
  it as `generationStartOrdinal`.
- The client may use locators/CFIs only for reader navigation and visible
  highlight mapping.

---

## Migration Status

| Phase | Status | Notes |
|---|---|---|
| 1-6 Playback state/model cleanup | Done | Cursor/session split, sidecar-only readiness, ordinal-only playback start, client controller/model extraction, cache reset epochs, and schema/key consolidation are complete. |
| 7 Playback-owned audio prefix | Done | Generated audio now lives under `tts_playback_segments_audio_v1/`; playback no longer writes `tts_segments_v2/`. |
| 8 Legacy audiobook retirement | Done | Legacy audiobook routes/hooks/blobstore/tables/runtime reads were removed. Export now reuses worker playback generation; Step 13 moved durable export artifacts to the worker. |
| 9 v5 decommission | Done | Legacy TTS/audiobook tables and object prefixes are dropped/purged through migration/bootstrap tooling. |
| 10 Audiobook export hardening | Done | Export speed/format and authoritative `completedCount` progress were implemented. The temporary same-origin download bridge was superseded by Step 13 worker-owned artifacts. |
| 11 Idempotent playback jobs | Done | Live and export sessions are deterministic and separate; both share per-ordinal segment cache without sharing cursor/session state. |
| 12 Compute worker API hard cut | Done | Worker routes use the finalized resource/job shape with no old aliases. |
| 13 Audiobook export reconnect + worker-owned artifacts | Done | Export resolve now reconnects deterministic generation/artifact operations; speed transcode, M4B packaging, chapter metadata, artifact storage, and download serving are worker-owned. |
| 14 Worker-owned document preview jobs | Done | Preview ensure/presign now resolve/create worker preview jobs; PDF first-page rendering and EPUB cover extraction are worker-owned. Any preview fallback byte proxy is step 17 cleanup debt. |
| 15 Worker-owned DOCX conversion | Done | DOCX upload finalize resolves/creates deterministic worker conversion jobs; LibreOffice runs only in the worker, and Next registers completed PDF artifacts through a short finalize call. |
| 16 Worker-owned account export artifacts | Done | Next writes bounded manifests and returns short snapshots; the worker builds durable ZIP artifacts; Next authorizes downloads and redirects to signed storage URLs. |
| 17 Final route hard cut and dead-code removal | Done | Same-origin control-plane downloads, fallback proxy removal, parsed-snapshot-only routes, local-library namespace split, and worker-delegated storage scans are complete. |
| 18 Explicit browser object transport + dual S3 endpoints | Done | `S3_INTERNAL_ENDPOINT`/`S3_PUBLIC_ENDPOINT`/`S3_BROWSER_TRANSPORT` select one deterministic transport; `S3_ENDPOINT` remains a deprecated startup-warning alias. |
| 19 Pre-merge review cleanup | Done | Branch review fixes: batched cleanup/KV reads, shared SSE-proxy and artifact-download helpers, operation-kind reuse policy registry, shared opKey scope parsing, dead worker config removal. |
| 20 Export storage layout and retention | Done | Audiobook export artifacts are user/document-scoped, export retention runs as a worker-owned maintenance sweep with a scheduled Next trigger, and per-kind worker policy is a single registry. |
| 21 Worker-owned document derived-artifact deletion | Planned | Move the remaining Next-side per-document S3 deletions (parsed PDF artifacts and preview images) into the worker so all derived-artifact deletion is worker-owned and control-plane-triggered. |

---

## Completed Work

### 1. Require Worker-Plan Ordinal for Audio Start

Playback start is ordinal-only. The client sends `startIntent.selectedOrdinal`,
and the worker validates it against the canonical plan before storing it as
`generationStartOrdinal`. EPUB CFI, viewport locator, page-start anchor, text,
segment key, and array index are no longer playback-start inputs.

### 2. Reduce Client EPUB Planning to Highlight Mapping

The worker owns durable EPUB extraction, segmentation, locators, ordinals, and
ordinal validation. The client owns only rendered text maps, CFI/page navigation,
stable spine anchors, and visible highlight mapping. Plan/session payloads no
longer send reader coordinates or text/key hints.

### 3. Extract the Playback Controller

`useTtsPlayback` owns the media controller: phase, unlocked audio ref, session
and timeline refs, playback time, stream creation, audio events, seek/resync,
foreground SSE sync, cursor heartbeat, visibility resync, projection loop, and
the in-flight driver. `TTSContext` remains the app-level state/actions facade.

### 4. Collapse Duplicate Client State

`useTtsPlaybackModel` is the single client holder for worker plan, canonical
segments, derived sentence strings, selected ordinal, and seek layout. Public
selection is `currentSentenceOrdinal`; playback entrypoints take ordinals.
`playbackAnchor` is only a reader viewport anchor and is not serialized into
playback session start requests.

### 5. Fix Clear Cache to be a Playback Reset Boundary

Clear cache now calls the worker reset endpoint before object deletion. The
worker bumps a durable cache epoch, cancels matching sessions, invalidates local
sidecar caches, and makes epoch-aware readers/writers reject stale sidecars and
late writes.

### 6. Consolidate IDs, Keys, and Schemas

Playback identity is ordinal-only across plan/grid/sidecar artifacts.
`segmentEntryId`, persisted/client-facing `segmentId`, and mirrored
`sourceSegmentIndex` are gone. Plan-operation and playback-session schemas are
separate and strict. `segmentKey` remains the canonical segmentation/content key;
`audioContentHash` is only the worker-local content-addressed audio key input.

### 7. Move Playback Audio to a Dedicated Playback-Owned Prefix

Playback generation now writes segment audio through
`buildTtsPlaybackSegmentAudioKey`:

`tts_playback_segments_audio_v1/[ns/<ns>/]users/<userId>/docs/<documentId>/<version>/<settingsHash>/<audioContentHash>.mp3`

The encoding is unchanged: generated audio still runs through `normalizeToMp3`
and `STREAM_AUDIO_PROFILE`. Existing `tts_segments_v2/` playback cache objects
were not copied; first playback after upgrade re-synthesizes into the new prefix.

### 8. Retire the Legacy Audiobook Pipeline; Download from the Worker Loop

The old audiobook implementation is retired. Export now creates a deterministic
document-extent playback session using `generationExtent: 'document'` and tracks
progress through the existing playback SSE snapshots (`completedCount` /
`plannedCount`). This was the interim bridge before Step 13. MP3 and M4B are now
served as worker-owned export artifacts; non-`1x` MP3 and M4B packaging no
longer run inside the Next audio response.

Removed runtime surface: `src/lib/client/audiobooks/`,
`src/lib/server/audiobooks/`, `src/app/api/audiobook/*`,
`src/lib/client/api/audiobooks.ts`, audiobook-specific hooks, live-schema
`audiobooks` / `audiobookChapters` tables, app/runtime reads and writes of those
tables, legacy audiobook tests, and the separate `audiobooks_v1/` runtime
storage prefix.

---

### 9. v5 Decommission: Drop Legacy TTS + Audiobook Storage

`0015_cleanup_pre_v5` drops legacy TTS/audiobook tables and deletes the retired
scheduled-task row. The recurring legacy cleanup task is gone. Bootstrap exports
idempotent `runV4Decommission(env)` for `tts_segments_v1/`, `tts_segments_v2/`,
and `audiobooks_v1/`; self-hosted startup runs it when S3 is configured, and
serverless/manual deploys can run `pnpm migrate-decommission`. The old FS->S3
migrator commands are removed.

Verified: `pnpm migrate`, `pnpm dev` startup smoke, and full unit suite.

---

### 10. Audiobook Export Hardening

The export modal exposes audiobook speed and output format. Progress is driven
by authoritative worker `completedCount` snapshots instead of seek-layout
polling. This originally used a same-origin audio bridge for download variants;
Step 13 superseded that bridge with durable worker-owned export artifacts and
download URLs.

Verified: `pnpm exec tsc --noEmit`, focused audiobook export/UI route tests, and
focused playback/worker route/storage/audio-layout tests.

---

### 11. Idempotent Playback Jobs and Shared Generation Cache

Live playback and audiobook export use separate deterministic sessions for the
same document/settings scope: `live` and `export-document`. Jobs are idempotent,
terminal jobs are replaceable, and both sessions share the per-ordinal segment
cache at `storageUserId + documentId + documentVersion + settingsHash + ordinal`.
Export starts output at ordinal `0`, runs document extent, and reports true
completed count across the plan. Sidecars carry short-lived generating leases;
fresh foreign leases are waited on and stale leases are stealable.

Verified: focused key/progress, route, and server-state tests; `pnpm exec tsc
--noEmit`; `pnpm test:unit`.

### 12. Compute Worker API Surface Hard Cut

Status: implemented. Hard cut only; do not add one-off compatibility routes,
alias routes, random-session lookups, or new legacy audiobook/PDF status APIs.

Implemented route structure:

- Keep health unchanged:
  - `GET /health/live`
  - `GET /health/ready`
- Keep generic operation observation unchanged:
  - `GET /v1/operations/:opId`
  - `GET /v1/operations/:opId/events`
- Use one resource namespace for PDF layout:
  - `POST /v1/pdf-layout/jobs` creates/reuses the deterministic layout job.
  - `POST /v1/pdf-layout/resolve` resolves current artifact + current job.
- Use one resource namespace for playback plans:
  - `POST /v1/tts-playback/plans/jobs` creates/reuses the deterministic plan
    job.
  - No playback plan resolver was added; current-plan resolution still stays in
    the Next proxy.
- Use one resource namespace for playback sessions:
  - `POST /v1/tts-playback/sessions/jobs` creates/reuses live or export
    playback generation for a deterministic session id.
  - `POST /v1/tts-playback/sessions/resolve` resolves deterministic session +
    operation + progress by canonical scope and purpose (`live` or
    `export-document`).
  - `GET /v1/tts-playback/sessions/:sessionId` reads session state.
  - `GET /v1/tts-playback/sessions/:sessionId/segments` lists completed segment
    sidecars.
  - `PUT /v1/tts-playback/sessions/:sessionId/cursor` updates live cursor.
  - `GET /v1/tts-playback/sessions/:sessionId/audio` streams MP3 bytes.

Implemented notes:

1. Renamed old worker routes to the target shape in one hard cut, updating
   OpenAPI, generated client types, Next proxy callers, docs, and tests
   together.
2. Deleted old route names in the same change. No aliases.
3. Added `POST /v1/tts-playback/sessions/resolve` only as a generic session
   resolver by canonical scope and purpose. Do not add an export-specific worker
   endpoint.
4. Kept generic operation event URLs as the single SSE primitive; domain routes
   should resolve the correct op id, not create separate event systems.
5. Added regression coverage for the complete route map so no new ad hoc worker
   endpoint lands without updating this section.

Verified: `pnpm compute:openapi:generate`, route/server-state tests, `pnpm exec
tsc --noEmit`, and `pnpm test:unit`.

---

### 13. Audiobook Export Reconnect and Worker-Owned Artifacts

Status: implemented. Reconnect and worker-owned export artifacts were implemented
together, so refresh/reopen resolves deterministic generation and artifact
preparation state instead of hardening the old same-origin ffmpeg bridge.

Hard cut only; do not add polling fallbacks, legacy audiobook status rows,
random export sessions, client-only progress reconstruction, `/api/audiobook/*`,
client Blob downloads, or Next-hosted ffmpeg packaging.

Target ownership:

- Worker owns audiobook export artifacts for a deterministic playback scope:
  canonical user/storage scope, document id/version, settings hash, output
  format, export speed, and plan object key.
- Worker builds MP3 speed variants and M4B/AAC-in-MP4 artifacts as background
  jobs, stores them as durable derived media, and emits progress through the
  existing operation event stream.
- Artifact preparation is a new worker job kind, not part of the existing
  `tts_playback` generation job. The existing `tts_playback` job with
  `generationExtent: 'document'` remains responsible for filling the canonical
  per-ordinal segment cache. The artifact-preparation job consumes that cache
  plus the plan/grid and produces one requested file variant.
- NATS/JetStream owns export job queueing, operation state, progress snapshots,
  and reconnect state. S3 owns the final audio artifact and any small artifact
  metadata sidecar. SQL is not used for export job state.
- Next owns authentication, scope resolution, plan/job resolution, and signed
  download URL issuance. It should not pipe the full worker audio stream through
  Vercel for normal downloads.
- Live playback audio remains the worker's streaming MP3 route. Export/download
  artifacts are separate job outputs so range streaming, retries, browser
  refreshes, and large libraries do not depend on one Vercel request.
- There is no separate "download job". The background work is export artifact
  preparation: assembling or transforming bytes into a reusable artifact. The
  actual download is a short control-plane action that returns or redirects to a
  signed URL for an already-ready artifact.

Final flow:

1. Next resolves current export state for the current document/settings/plan
   before starting new work. The modal calls the read-only resolver on open so a
   browser refresh can rediscover a running or completed export without a
   second generate click.
2. The playback generation phase uses the deterministic `export-document`
   session id derived from canonical playback scope.
3. If generation is `queued` or `running`, the modal subscribes to the
   generation operation SSE by operation id through the export events proxy and
   shows completed/planned sidecar progress. It does not depend on a transient
   Next-side session lookup after refresh.
4. If generation is complete but the requested `format + speed` artifact is not
   ready, Next creates or resolves a separate deterministic worker
   artifact-preparation job for that file variant.
5. If artifact preparation is `queued` or `running`, the modal subscribes to
   that artifact operation SSE by operation id.
6. If the artifact is ready, Next returns or redirects to a signed worker or
   object-storage download URL. This is not a queued job, and the modal marks
   segment progress as fully complete from the canonical plan count.
7. If either phase fails, the modal shows failed/retry state for the same
   deterministic generation or artifact-preparation job.

Implemented:

1. Added a Next export resolve endpoint, analogous to
   `GET /api/documents/:id/parsed`, that returns one snapshot for both phases:
   generation session/op state plus artifact-preparation state for the
   requested format and speed.
2. Uses the Step 12 generic playback session resolve route for generation state.
   Require a loaded canonical playback plan and `planObjectKey`; do not fall
   back to random sessions or client-reconstructed progress.
3. Added a new worker operation kind for export-artifact preparation under the
   finalized playback namespace. Store the op index/state in JetStream KV and
   keep the generic `/v1/operations/:opId/events` SSE primitive.
4. Derives a deterministic export artifact id from canonical playback scope plus
   `format` and export `speed`.
5. Moved MP3 `atempo`, M4B packaging, chapter ffmetadata generation, temp-file
   finalization, and object upload into the Railway worker.
6. Stores artifact metadata with content type, byte length,
   disposition filename, source plan key, source session id, and generation
   status.
7. Added modal/client resolve handling for the two-phase generation/artifact
   workflow, including read-only hydration on open, generation operation SSE
   reconnect, artifact operation SSE reconnect, and completed-artifact progress
   hydration.
8. Changed the ready download path to use a signed worker artifact URL. The old
   same-origin audio route rejects speed/M4B export requests instead of doing
   background work inside the download response.
9. Removed `ffmpeg` execution from
   `/api/tts/stream/[sessionId]/audio` once worker artifacts are live.
10. Updated regression coverage to pin the new worker route surface, export
    operation ownership, artifact SSE path, and the absence of Next-side ffmpeg
    packaging/transcoding.
11. Updated cache clearing so it bumps the worker playback cache epoch, cancels
    matching sessions, invalidates matching playback/plan/export operation
    records, deletes segment audio/sidecars/plans, and deletes matching durable
    export artifacts. Export operation invalidation is best-effort when an
    in-flight operation has no artifact metadata yet; once metadata exists,
    storage-user/document/version/settings matching gates artifact deletion.
    (Superseded by Step 20: export artifacts are user/document-scoped objects,
    artifact deletion is bounded by the scope prefix, and export operation
    keys carry the owner so invalidation needs no metadata reads.)

Verified: `pnpm compute:openapi:generate`, `pnpm exec tsc --noEmit`, focused
server-state architecture tests, cache-clear tests, worker route tests, and
worker-loop tests.

### 14. Worker-Owned Document Preview Jobs

Status: implemented. Preview image generation is worker-owned derived-media
compute, and thumbnail readiness now follows operation SSE instead of polling.

Target ownership:

- Next owns auth, document metadata/scope checks, preview job creation or
  resolution, operation SSE proxy authorization, and presigned URL issuance for
  completed preview images.
- Worker owns preview generation for PDF, EPUB, and future document-derived
  preview formats. It reads source blobs, renders/extracts images, normalizes
  output, and writes preview artifacts under the existing preview object prefix.
- NATS/JetStream owns preview job queueing, operation state, progress, and retry
  state. S3 owns source blobs, preview images, and preview metadata. SQL remains
  a Next-owned document metadata source only.
- Preview delivery must use presigned object URLs. Any remaining preview byte
  proxy fallback route is cleanup debt; it must not render previews and should
  be removed in the final route audit.

Implemented:

1. Added worker preview job resources:
   `POST /v1/document-previews/jobs` and
   `POST /v1/document-previews/resolve`.
2. Jobs are keyed by document id, namespace, source blob key, source modified
   time, preview kind, and renderer version.
3. Job payloads carry source object keys and bounded renderer options; the
   worker does not query SQL for document rows.
4. PDF first-page rendering and EPUB cover extraction live in the compute
   worker.
5. Next preview ensure/presign routes now resolve/create worker jobs and return
   pending/failed/ready snapshots with the current worker `opId`; they do not
   render previews.
6. Thumbnail readiness uses a bounded authenticated Next SSE proxy over the
   existing worker `/v1/operations/:opId/events` primitive. The proxy validates
   document ownership and `document_preview` subject scope before forwarding.
7. The `DocumentPreview` client removed the `retryAfterMs`/timer loop. It does
   one ensure call, subscribes to operation SSE when pending, and performs one
   final ensure/presign/cache-prime fetch after a succeeded snapshot.
8. Completed preview delivery uses presigned S3 URLs. Any fallback byte proxy
   that still exists is final cleanup debt, not part of the target architecture.
9. Regression coverage pins the no-polling component path, pending `opId`
   contract, preview SSE proxy authorization, worker route surface, worker-loop
   handling, and compute-worker SQL boundary.

Hard cuts and cleanups:

- No client polling for worker preview completion.
- No Next-side PDF/EPUB preview rendering fallback.
- No new worker event primitive; keep `/v1/operations/:opId/events`.
- No worker SQL access for preview jobs.
- No preview-specific status table beyond the existing short metadata row used
  for ready/queued/failed library state.

Verified: `pnpm compute:openapi:generate`, `pnpm exec tsc --noEmit`, focused
preview render tests, worker route tests, worker-loop tests, JetStream adapter
tests, worker-loop policy tests, server-state architecture tests,
`pnpm run check:compute-boundary`, and preview SSE proxy tests.

### 15. Worker-Owned DOCX Conversion

Status: implemented. Upload finalize stays a short metadata/control route.
DOCX conversion is long-running native-process compute and now runs on Railway.

Implemented:

1. Added worker conversion resources:
   `POST /v1/document-conversions/docx/jobs` and
   `POST /v1/document-conversions/docx/resolve`.
2. Jobs are keyed by namespace, temp source object key, source metadata, and
   converter version. Payloads carry object keys and source metadata only; the
   worker does not query SQL or upload rows.
3. Moved LibreOffice invocation and temp-file handling into the compute worker.
   The old Next-side `src/lib/server/documents/docx-convert.ts` helper is gone.
4. DOCX upload finalize returns `202` with conversion operation state when the
   worker artifact is not complete. The same existing finalize route registers
   the converted PDF after worker completion; no new upload-specific SSE route
   or long wait loop was added.
5. The worker writes converted PDF artifacts and metadata sidecars under
   `document_conversions_v1/docx/`; Next copies the ready artifact into the
   canonical document blob location and creates the SQL document row.
6. Regression coverage pins that DOCX finalize never reads/converts DOCX bytes
   in Next, completed conversion registers exactly one PDF document, the worker
   route surface includes conversion job/resolve resources, and compute-worker
   source remains independent from app server modules.

Verified: `pnpm compute:openapi:generate`, `pnpm exec tsc --noEmit`, focused
DOCX finalize tests, server-state architecture tests, compute worker client
contract tests, worker route tests, and worker-loop tests.

---

### 16. Worker-Owned Account Export Artifacts

Status: completed. This is worker-owned for artifact assembly, not
worker-owned for account metadata. Next remains the SQL/control plane and writes
a bounded manifest to object storage; the worker owns ZIP assembly, document
blob reads, durable artifact upload, progress, and reconnect state. Next owns
download authorization and short-lived storage presigning.

Target ownership:

- Next owns auth, account scope, export request validation, job
  creation/resolution, SQL reads, manifest creation, operation SSE proxy
  authorization, and signed URL issuance.
- Worker owns large export ZIP assembly, document blob reads from object
  storage, compression, progress, and durable artifact upload.
- The user-facing export route should return a snapshot or redirect to a
  completed artifact. It should not keep a Vercel response open while streaming
  every document blob into an archive.
- The Next app must not poll for worker-owned export completion. Pending export
  snapshots must include the worker `opId`, and the browser should subscribe
  through a narrow authenticated Next SSE proxy that forwards the existing
  worker `/v1/operations/:opId/events` stream after validating account/export
  scope.
- NATS/JetStream owns account export job queueing and operation state. S3 owns
  the export input manifest and output ZIP artifact. SQL account/document data
  remains Next-owned; Next materializes the export manifest from SQL before
  enqueueing the worker job.

Final flow:

1. Client asks Next to resolve/create an account export.
2. Next authenticates, checks account scope, applies policy, reads the required
   SQL metadata, and writes a bounded export manifest to object storage.
3. Next enqueues or resolves a deterministic worker export job keyed by user
   scope, export schema version, selected scopes/options, and manifest key.
4. Worker reads the manifest and referenced document blobs from object storage,
   builds the ZIP, writes the durable export artifact and metadata, and updates
   operation progress in NATS/JetStream.
5. Next returns short snapshots with the current `opId` while the job is
   pending/running, and exposes a same-origin export-events proxy to the generic
   worker operation event stream. The client does not use timers or
   `retryAfterMs` loops.
6. When complete, Next returns a short same-origin download URL. That route
   re-authenticates the app session, resolves the artifact through the worker,
   and redirects to a short-lived S3 presigned URL for the durable ZIP artifact.

Manifest/artifact reuse policy:

- Treat manifests as immutable export snapshots, not one permanent blob per user.
- Reuse an existing `queued` or `running` job when the same user, scope,
  options, schema version, and manifest content hash are already active.
- Reuse a completed artifact while it is still fresh and its manifest hash still
  represents the requested account snapshot.
- A "Generate new export" action or changed account/document data creates a new
  manifest content hash, a new manifest object, and a new ZIP artifact.
- Expire old manifests and ZIP artifacts through bounded cleanup.

Implemented:

1. Added worker account export routes:
   - `POST /v1/account-exports/jobs`
   - `POST /v1/account-exports/resolve`
2. Added a new `account_export` worker operation kind, JetStream subject,
   consumer, operation key, progress shape, orphan recovery handling, and
   OpenAPI/generated client surface.
3. Replaced Next-side ZIP streaming with `/api/user/export` manifest creation
   and worker job resolve/create. Object storage and compute worker
   configuration are required; there is no metadata-only or Vercel ZIP fallback.
4. Added `/api/user/export/events` as a narrow same-origin SSE proxy to the
   generic worker operation event stream. It validates the signed-in user and
   namespace before forwarding.
5. Added `/api/user/export/download` as the only browser-facing account export
   download route. It validates the signed-in user, resolves the account export
   metadata through the worker, and redirects to a short-lived S3 presigned URL.
   The worker does not expose a public account export byte-serving endpoint.
6. Updated the settings UI to start/resolve the worker export, subscribe to SSE
   while pending, and perform one final same-origin resolve to obtain the
   same-origin download URL.
7. Stored manifests, ZIPs, and metadata under
   `account_exports_v1/[ns/<ns>/]users/<userId>/<artifactId>/`, so account
   deletion and test teardown can delete user/namespaced export artifacts
   without scanning global artifact ids.
8. Added regression coverage for the hard-cut route map, manifest construction,
   worker loop plumbing, and account deletion cleanup.

Verified: `pnpm compute:openapi:generate`, `pnpm exec tsc --noEmit`, focused
worker route/loop, architecture, data-export, and cleanup unit tests; the focused
unit command exercised the full configured unit suite.

---

## Completed Work (continued)

### 17. Final Route Hard Cut and Dead-Code Removal

Status: complete. This is an implementation and cleanup step. The goal is to
leave a clean route surface with no compatibility shims, no old-path aliases, no
byte proxy fallbacks, and no dead code kept for "just in case" behavior. Storage
is required. The list below is a minimum scope, not a ceiling: remove any
additional obsolete routes, helpers, callers, tests, generated types, docs,
config, env flags, scripts, or storage cleanup paths discovered while doing the
work, as long as they are part of the same ownership hard cut.

Target route contract:

- Next owns bounded control-plane routes only: authenticate, authorize, validate
  scope, enqueue/resolve worker jobs, proxy authorized SSE, finalize SQL
  metadata, return short JSON snapshots, and redirect to short-lived
  object-storage presigned URLs.
- Worker owns long-running and heavy data-plane work: provider/model calls,
  parsing, rendering, conversion, audio generation, transcoding, archive
  assembly, broad object scans, and durable artifact writes.
- Browser downloads go through same-origin Next control-plane authorization and
  then redirect to object storage. Browser downloads must not hit worker
  byte-serving routes and must not stream large bodies through Next.
- Renames are hard cuts. When a route is renamed or re-shaped, update every
  caller and delete the old route, helper code, tests, generated types, and docs.

Implementation work:

1. Replace audiobook export worker downloads with a same-origin control-plane
   route:
   - Add `/api/tts/export/download`.
   - The route authenticates the user, resolves export artifact ownership, and
     redirects to a short-lived object-storage presigned URL.
   - Update `/api/tts/export/resolve` and the export modal to use the new
     download route.
   - Remove `GET /v1/tts-playback/exports/:artifactId/download` if no internal
     worker owner remains, plus its token/download helpers and OpenAPI/generated
     client surface.
2. Remove the live-session MP3 byte proxy:
   - Delete `/api/tts/stream/[sessionId]/audio`.
   - Stop returning `downloadUrl` from `/api/tts/stream/sessions`.
   - Keep live playback on the signed worker `audioUrl`.
   - Route downloadable audio through audiobook export artifacts instead.
3. Remove document blob byte fallback routes:
   - Delete `/api/documents/blob/get/fallback`.
   - Delete `/api/documents/blob/upload/fallback`.
   - Delete `/api/documents/blob/preview/fallback`.
   - Update presign/ensure clients so failure is explicit instead of redirecting
     into a proxy fallback.
4. Split parsed PDF delivery into control plane plus object delivery:
   - Keep `/api/documents/[id]/parsed` for short parse snapshots and job
     creation/resolution only.
   - Add a presigned object delivery path for completed parsed artifacts if the
     client still needs direct artifact reads.
   - Remove completed parsed JSON byte responses from the generic parsed route.
5. Keep preview ensure/presign routes as control plane, but remove all fallback
   fields from their response shapes once fallback routes are deleted.
6. Decide the local library content route explicitly:
   - If local library file serving is desktop/self-host only, move it under an
     explicit local-library namespace and keep it out of the cloud route surface.
   - Otherwise remove `/api/documents/library/content`.
7. Move or bound maintenance routes that can exceed a short control-plane
   request:
   - Review `/api/admin/tasks/[key]/run`, `/api/admin/tasks/tick`, account
     deletion, and TTS segment clear.
   - Queue worker/maintenance jobs for broad object scans or deletes instead of
     doing them inline in Next request handlers.
8. Remove stale runtime references to dropped state, routes, and helpers:
   `ttsPlaybackSessions`, `ttsSegmentEntries`, `ttsSegmentVariants`,
   `audiobookChapters`, `/api/audiobook`, `cleanup-legacy-tts-playback-cache`,
   `migrate-fs`, `openreader-migrate-storage`, Next-side `ffmpeg` execution in
   playback audio routes, request-path `convertDocxBufferToPdfBuffer`, and
   request-path preview rendering. Also remove any newly discovered stale
   runtime path that exists only to support removed routes or pre-hard-cut
   behavior. Migration history, frozen versioned docs, and decommission docs are
   allowed exceptions.
9. Tighten regression coverage:
   - Pin the final Next API route map.
   - Pin the final worker API route map.
   - Assert removed routes and old callers are absent.
   - Assert worker-owned operation clients expose `opId` and use authenticated
     same-origin SSE proxies instead of polling.
   - Assert new worker-owned preview, conversion, export, and audiobook artifact
     code does not import app SQL/database modules, except the existing
     read-only `admin_providers` credential resolution for TTS provider keys.
10. Run final validation from a clean local state:
    `pnpm migrate`, `pnpm test:unit`, `pnpm exec tsc --noEmit`, and a
    `pnpm dev` startup smoke test. Optionally run the highest-value Playwright
    smoke path for upload/open/playback and audiobook MP3 export if the local
    worker/TTS provider is available.

Initial hard-cut implementation completed:

- Audiobook artifact downloads now use `/api/tts/export/download`, which
  authenticates and authorizes the document scope, resolves worker-owned
  artifact metadata, and redirects to a short-lived S3 URL. The public worker
  byte-serving export download route is replaced by a private metadata route.
- The live-session Next MP3 proxy and its `downloadUrl` response field are
  removed; live playback uses the signed worker `audioUrl` only.
- All document blob upload/get/preview fallback proxy routes and client fallback
  behavior are removed. Presign failures are explicit storage failures.
- `/api/documents/[id]/parsed` returns parse snapshots only. Completed parsed
  artifacts are delivered through the authorized
  `/api/documents/[id]/parsed/download` redirect route.
- Route-map and lifecycle coverage now assert the hard cut and the separate
  parsed-artifact delivery flow.
- Local filesystem library listing and content now live exclusively under
  `/api/local-library`; the former `/api/documents/library*` cloud-looking
  routes are removed.
- Playback cache deletion and account-deletion artifact cleanup delegate S3
  scans and deletions to authenticated compute-worker endpoints. Next retains
  authentication, scope/ownership resolution, bounded document-id batching, and
  SQL cleanup only.
- Scheduled task handlers now have explicit 30–45 second ceilings, while the
  manual-run and cron routes have a 60 second request ceiling.

Final validation completed: `pnpm migrate`, `pnpm compute:openapi:generate`,
`pnpm test:unit`, `pnpm exec tsc --noEmit`, and a `pnpm dev` readiness smoke
test. The development watcher emitted host `EMFILE` watch-limit warnings but
the Next app, embedded object storage, NATS, and compute worker all reached
ready state.

---

### 18. Hard Cut: Explicit Browser Object Transport and Dual S3 Endpoints

Status: complete. This is a configuration and route-contract hard cut for
self-hosted, Docker, and cloud deployments. It keeps same-origin object proxying
as a supported embedded/self-hosted transport, but never as a reactive fallback
after a browser presign attempt fails. The server selects one transport before a
transfer begins, making deployment behavior predictable and observable.

Browser object transport is selected deterministically with
`S3_BROWSER_TRANSPORT`:

| Setting | Behavior | Valid deployment |
|---|---|---|
| `proxy` | Browser transfers document/preview bytes through same-origin Next routes. | Self-hosted only; the normal embedded SeaweedFS choice. |
| `presigned` | Browser transfers directly to the configured public S3 endpoint. | External S3 or SeaweedFS exposed as a public S3 origin. |
| `auto` | `proxy` for embedded storage; `presigned` when a public S3 endpoint is configured; otherwise fail startup with an actionable configuration error. | Default. |

`proxy` is not permitted on Vercel/cloud request-duration hosting. `presigned`
is the required cloud transport. No client may attempt direct transfer and then
retry through a proxy after an arbitrary error: a CORS/network error can occur
after an object was accepted, and retrying masks deployment defects while
silently moving large traffic through the app.

Target configurations:

```
Embedded/self-hosted default
Browser -> https://reader.example -> OpenReader proxy routes -> http://127.0.0.1:8333 SeaweedFS

Public object storage
Browser -> https://s3.reader.example -> SeaweedFS/S3
App/worker -> http://seaweedfs:8333 (or another private S3 endpoint)
```

A presigned S3 API must use a dedicated host/subdomain (for example,
`s3.reader.example`), not a path mount such as `https://reader.example/s3`.
The presigned canonical path includes the S3 request path, so proxy path stripping
or rewriting invalidates the signature. A different port is also a different
browser origin and needs CORS.

Configuration contract:

- `S3_INTERNAL_ENDPOINT`: private endpoint used by all app and compute-worker
  S3 operations.
- `S3_PUBLIC_ENDPOINT`: browser-reachable HTTPS endpoint used only to generate
  presigned URLs.
- `S3_BROWSER_TRANSPORT`: `auto`, `proxy`, or `presigned`, default `auto`.
- `S3_ENDPOINT`: deprecated compatibility alias. When `S3_INTERNAL_ENDPOINT`
  is absent, it supplies the internal endpoint; when `presigned` is selected
  and `S3_PUBLIC_ENDPOINT` is absent, it also supplies the public endpoint.
  Emit a startup warning and document removal in the next major release. New
  Compose files and docs must use the explicit settings only.

Implementation work:

1. Introduce the explicit settings and one validated storage-transport resolver
   shared by the Next app, bootstrap process, and compute worker. Remove the
   current public-host-to-loopback rewriting and any assumption that one endpoint
   is simultaneously private and browser-reachable.
2. Make embedded SeaweedFS bind independently of browser configuration:
   - Add explicit embedded bind host/port settings, defaulting to local HTTP
     port `8333`.
   - Start the embedded worker with `S3_INTERNAL_ENDPOINT`.
   - Do not derive a bind port or local protocol from a public URL.
3. Establish canonical proxy-mode routes for document upload, document read, and
   preview bytes. They are supported only in `proxy` mode; delete the old
   `/fallback` aliases rather than retaining two path contracts. Presign routes
   are supported only in `presigned` mode. Update every browser client to use
   the server-selected transport, never try both.
4. Generate every direct browser presign from the public client, while all
   server/worker storage operations use the internal client. Cover document PUT
   and GET, preview GET, parsed artifact GET, account/audiobook export GET, and
   future browser-direct artifact flows.
5. For `presigned` mode, document and validate the reverse-proxy/S3 contract:
   preserve signed paths, query strings, `Host`, and signed headers; do not
   rewrite S3 paths. Configure SeaweedFS CORS for the app origin with `GET`,
   `HEAD`, `PUT`, and `OPTIONS`, plus `Content-Type` and
   `x-amz-server-side-encryption` request headers.
6. Rewrite Docker Compose examples, self-hosting docs, `.env.example`, and
   current blob-storage docs around the two supported modes. Remove stale
   instructions that describe automatic fallback behavior. Show the embedded
   single-origin proxy mode as the default and a separate SeaweedFS container
   plus `s3.<domain>` as the presigned topology.
7. Add regression/integration coverage for deterministic transport resolution,
   `S3_ENDPOINT` deprecation warnings, proxy-mode byte delivery, public-vs-
   internal endpoint selection, path-style SeaweedFS signatures, CORS
   preflight, and an HTTPS reverse-proxy smoke path.

---

### 19. Pre-Merge Branch Review Cleanup

Status: complete. A full-branch review (dead code, leftover fallback/split
logic, duplication, and efficiency) ran before merge. The hard cut itself came
back clean — no compatibility shims, fallback byte proxies, stale callers, or
invariant violations were found. The verified findings were fixed as follows:

1. Shared `packages/compute-worker/src/storage/prefix-cleanup.ts` now owns
   `deletePrefix`, `storageUserHash`, and
   `findOwnedTtsPlaybackExportPrefixes`. Playback cache-clear and account
   storage cleanup both use it; export metadata sidecar reads are batched in
   groups of 32 instead of sequential per-object round-trips.
2. `listSessions` in the playback KV store batches session reads and cursor
   overlay reads in groups of 32 instead of two sequential KV reads per
   session on the cache-reset path.
3. The four Next operation-event SSE proxy routes (account export, audiobook
   export, document preview, playback stream) share
   `src/lib/server/compute-worker/operation-events-proxy.ts`. Routes keep
   their own auth/scope validation; the reconnectable stream plumbing
   (Last-Event-ID resume, SSE headers, upstream failure mapping) exists once.
4. The three artifact download routes (audiobook export, account export,
   parsed PDF) share `sendStorageArtifact` and `cleanDispositionFilename` in
   `src/lib/server/storage/artifact-download.ts`, so proxy-vs-presigned
   transport behavior, disposition sanitization, and the 5-minute presign
   expiry cannot drift per route.
5. Succeeded-operation reuse policy moved from a hardcoded kind list in
   `shouldReuseExistingOperation` to the exhaustive
   `WORKER_OPERATION_KIND_REUSES_SUCCEEDED` record in
   `operations/contracts.ts`; the compiler now forces every new operation
   kind to choose a reuse policy.
6. `operationMatchesTtsResetScope` no longer hand-parses opKey segments by
   array index. `ttsPlaybackResetScopeFromOperationKey` lives beside the key
   builders in `operations/keys.ts`, so a key-format change cannot silently
   desync cache-reset scope matching.
7. Removed dead worker config surface: `getWorkerClientWaitTimeoutMs` and the
   stale `ComputeOperationKind` type (it was missing `account_export` and had
   no callers), plus their orphaned wait-buffer constants.
8. Orphaned playback plans are reaped through the worker. Plans are keyed by
   document id only, so account deletion (SQL cascade + orphan reaper)
   previously left them behind as orphaned segmented document text. This was
   handled by `POST /v1/tts-playback/plans/clear`; Step 21 added sibling
   resource-owned cleanup routes for parsed layouts and previews.

Reviewed and intentionally unchanged: client hook fetches already run in
parallel, the scrubber gradient memo is stable between projection ticks, and
the sidecar scan constants are single-module implementation details. The
review also flagged that account deletion does not sweep pre-v5 prefixes;
that is by design — `runV4Decommission` is the sole owner of legacy purge,
and v5 runtime code does not reference pre-v5 prefixes.

---

### 20. Export Storage Layout and Retention

Status: complete. This closes the storage-layout and lifecycle debt the
Step 19 review surfaced, before the new export prefixes ship in a release.

1. Audiobook export artifacts are user/document-scoped. Artifact and metadata
   keys moved from the flat `tts_playback_exports_v1/<artifactId>/` namespace
   to `tts_playback_exports_v1/users/<userId>/docs/<documentId>/<artifactId>/`
   (no namespace segment, matching segment audio: the worker job request
   carries no namespace and isolation comes from the user id). This was a free
   hard cut because the prefix never shipped in a release. Consequences:
   - Playback cache-clear deletes the user/document scope prefix directly;
     only a version-bounded clear still reads metadata, and only within that
     bounded prefix.
   - Account deletion deletes `tts_playback_exports_v1/users/<userId>/` as a
     plain prefix; the global metadata ownership scan is gone.
   - The worker export metadata read routes (`GET
     /v1/tts-playback/exports/:artifactId` and `POST
     /v1/tts-playback/exports/resolve`) now require the user/document scope,
     and `/api/tts/export/download` authorizes the document scope before
     resolving the artifact instead of after.
   - Export operation keys carry the owning `storageUserId`, so cache-reset
     invalidation matches owner + document/version/settings from the opKey
     alone — no metadata reads, and another user's export operations are
     never invalidated. Plan operations remain owner-less by design: the plan
     is a shared derived artifact and its objects are deleted by the same
     reset.
2. Export retention is enforced. Each export resource namespace owns its
   retention sweep — `POST /v1/account-exports/expire` scans
   `account_exports_v1/` and `POST /v1/tts-playback/exports/expire` scans
   `tts_playback_exports_v1/` (no separate maintenance namespace was added to
   the hard-cut route map). Each sweep reads metadata sidecars in batches and
   deletes artifact directories (metadata + ZIP/audio + manifest) whose
   `createdAt` is past the retention window. Metadata is written only on
   completion, so in-flight preparations are never swept, and the schema
   floors `maxAgeMs` at one hour. The Next scheduled task
   `expire-export-artifacts` triggers both (default daily, 7-day retention)
   per the Step 17 maintenance contract; expired exports are simply
   regenerated by the next resolve/create request.
3. Per-kind worker policy lives in one registry.
   `WORKER_OPERATION_KIND_POLICY` in `operations/contracts.ts` now carries
   both `reusesSucceeded` and `slowJobLogThresholdMs`; the state machine and
   worker loop read it, and the exhaustive `Record` forces every new operation
   kind to declare its policy in one place.

Verified: `pnpm compute:openapi:generate`, `pnpm exec tsc --noEmit`, and
`pnpm test:unit` (route-map, cache-clear, and architecture pins updated for
the new key layout, maintenance route, and policy registry).

---

### 21. Worker-Owned Document Derived-Artifact Deletion

Status: complete. Document-derived artifact deletion now uses worker-owned,
resource-scoped hard-cut paths.

1. `POST /v1/pdf-layout/clear`, `POST /v1/document-previews/clear`, and
   `POST /v1/tts-playback/plans/clear` keep cleanup in the same namespaces as
   each resource's resolve/create routes. The first two accept `documentId`
   and `namespace`; plans are document-keyed and accept `documentId` only.
   Shared worker storage helpers derive and delete the current prefixes, and
   the plan route also evicts matching entries from its local cache.
2. The orphaned-blob reaper calls all three routes with its task abort signal
   before deleting the source blob. A missing worker or any cleanup failure
   leaves the source in place for a later retry.
3. Next no longer deletes or constructs deletion paths for parsed PDF or
   preview artifacts. `deleteDocumentBlob` deletes only the source object; the
   obsolete parsed single-object and source-child cleanup paths and the
   preview deletion helper are gone.
4. Source blob reference counting, SQL ownership rows, preview SQL rows, and
   the bounded per-document trigger remain Next-owned. No global object scan
   was introduced.

Verified by the generated worker OpenAPI/client contract, the hard-cut route
map, worker cleanup unit coverage, orphan-reaper coverage, compute-boundary
checks, type checking, and the unit suite.
