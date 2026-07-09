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
- Document upload/download/preview primary paths should use S3 presigned URLs.
  Fallback proxy routes may remain as degraded compatibility paths, but they
  must not become the primary data plane because they buffer request or object
  bodies inside Vercel functions.
- PDF parse and TTS playback generation are worker-owned jobs. Next creates or
  resolves deterministic jobs, returns short snapshots, and proxies operation
  SSE only as a bounded reconnectable stream. Completed parsed PDF artifacts
  should be delivered primarily through signed object URLs; same-origin parsed
  JSON byte proxying is compatibility/small-artifact behavior, not the primary
  data plane.
- TTS live playback audio should use the signed Railway worker URL directly.
  Same-origin Next audio routes are narrow compatibility/control-plane bridges;
  normal audiobook downloads use worker-owned export artifacts.
- Scheduled tasks may remain in Next while they are bounded maintenance work
  below Vercel's limit. They must not grow into parse/TTS/render/transcode/export
  jobs.

Current known ownership debt:

- `/api/tts/stream/[sessionId]/audio` still exists as a narrow same-origin MP3
  compatibility proxy for authenticated playback/download cases, but it does
  not own audiobook speed transcodes or M4B packaging. Export variants are
  worker-owned artifacts.
- `/api/documents/[id]/parsed` still can return completed parsed PDF JSON bytes
  through Next instead of making signed object delivery the primary artifact
  path.
- User data export streams a ZIP archive and document blobs from Next.

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

The audio route builds a CBR whole-document layout from the plan plus completed
sidecars. Generated segments use exact probed duration. Missing segments are
represented by frame-aligned silence estimates, so byte-range seeking can target
ungenerated regions without cutting a segment in half.

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
- Seeks are whole-document time/byte operations and do not split segments.
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
| 14 Worker-owned document preview jobs | Done | Preview ensure/presign/fallback now resolve/create worker preview jobs; PDF first-page rendering and EPUB cover extraction are worker-owned. |
| 15 Worker-owned DOCX conversion | Done | DOCX upload finalize resolves/creates deterministic worker conversion jobs; LibreOffice runs only in the worker, and Next registers completed PDF artifacts through a short finalize call. |
| 16 Worker-owned account export artifacts | Done | Next writes bounded manifests and returns short snapshots; the worker builds durable ZIP artifacts; Next authorizes downloads and redirects to signed storage URLs. |

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
  - `POST /v1/tts-playback/cache/reset` bumps cache epoch and cancels sessions.

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
- Fallback preview proxy routes remain only as degraded compatibility paths for
  reading completed preview bytes and text snippets; they do not claim or render
  new previews in request.

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
5. Next preview ensure/presign/fallback routes now resolve/create worker jobs
   and return pending/failed/ready snapshots with the current worker `opId`;
   they do not render previews.
6. Thumbnail readiness uses a bounded authenticated Next SSE proxy over the
   existing worker `/v1/operations/:opId/events` primitive. The proxy validates
   document ownership and `document_preview` subject scope before forwarding.
7. The `DocumentPreview` client removed the `retryAfterMs`/timer loop. It does
   one ensure call, subscribes to operation SSE when pending, and performs one
   final ensure/presign/cache-prime fetch after a succeeded snapshot.
8. Completed preview delivery still prefers presigned S3 URLs, with the fallback
   proxy limited to compatibility reads.
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

## Final Steps

### 17. Route Ownership and Security Audit

After the worker ownership steps are verified, the last pass is a route-by-route
ownership audit. Storage is required in this architecture; do not add
metadata-only, local filesystem, or ad hoc ZIP fallbacks.

- Run a final repo scan for runtime references to dropped symbols and routes:
  `ttsPlaybackSessions`, `ttsSegmentEntries`, `ttsSegmentVariants`,
  `audiobookChapters`, `/api/audiobook`, `cleanup-legacy-tts-playback-cache`,
  `migrate-fs`, `openreader-migrate-storage`, Next-side `ffmpeg` execution in
  playback audio routes, request-path `convertDocxBufferToPdfBuffer` usage, and
  request-path `ensureDocumentPreview` generation. Also verify completed parsed
  PDF artifacts are primarily delivered by signed object URL rather than a
  Vercel byte proxy. Migration history, frozen versioned docs, and decommission
  docs are allowed exceptions.
- Re-scan Next API route ownership against the rule in this document: Vercel
  routes may authenticate, authorize, presign, enqueue, resolve, redirect, and
  return short JSON snapshots; Railway worker owns long-running stream,
  provider/model, render, parse, transcode, convert, archive, and large object
  scan work.
- For browser downloads, prefer a same-origin Next control-plane route that
  verifies the app session and redirects to a short-lived object-storage
  presigned URL. Avoid browser-to-worker byte downloads for account data and
  other user exports. Do not add ZIP download proxies unless object storage is
  unavailable by design, which is not true for the hard-cut architecture.
- Remove or transition Next routes that can exceed five minutes, hold large
  response bodies open, perform provider calls, run document conversion,
  generate previews, transcode audio, assemble archives, or scan broad object
  prefixes. Keep only bounded control-plane routes in Next.
- Rename routes that hide ownership. Route names should distinguish control
  plane actions (`/resolve`, `/download`, `/events`) from worker-owned jobs and
  object delivery; compatibility proxies should include explicit comments and
  regression coverage explaining why they remain.
- Re-scan every worker-owned operation integration for Next-side polling. A
  pending worker operation exposed to the browser must return an `opId` and use
  a same-origin, domain-scoped Next SSE proxy to the generic worker
  `/v1/operations/:opId/events` stream. The proxy must validate authenticated
  ownership/scope before forwarding. Do not add `retryAfterMs` loops, hidden
  timers, or worker operation-specific event primitives.
- Re-scan worker SQL boundaries. New worker-owned preview, conversion, export,
  and audiobook artifact code must not import database/schema modules or query
  app SQL tables. The only allowed current SQL exception is read-only
  `admin_providers` credential resolution for TTS provider keys.

Initial audit findings after step 16:

- Keep `/api/user/export`, `/api/user/export/events`, and
  `/api/user/export/download` as bounded Next control-plane routes. Do not
  reintroduce `GET /v1/account-exports/:artifactId/download`; account export
  browser downloads must go through app-session auth and object-storage
  presigning.
- Revisit `/api/tts/export/resolve` and
  `GET /v1/tts-playback/exports/:artifactId/download`. Audiobook exports still
  use browser-to-worker signed download URLs. They may be acceptable for
  playback-specific artifacts, but the safer and more consistent route shape is
  a same-origin Next `/api/tts/export/download` route that resolves ownership
  and redirects to a storage presigned URL.
- Keep `/api/tts/stream/[sessionId]/audio` only as a documented compatibility
  proxy for the canonical 1x MP3 stream. It holds a large response body open and
  should not grow new export formats or transcode behavior.
- Revisit byte fallback routes:
  `/api/documents/blob/get/fallback`,
  `/api/documents/blob/upload/fallback`, and
  `/api/documents/blob/preview/fallback`. They are marked degraded fallback
  paths and have presign-first siblings, but they still proxy large objects
  through Next. Step 17 should decide whether to remove them, gate them harder,
  or rename them to make the degraded compatibility purpose explicit.
- Keep `/api/documents/blob/preview/ensure` as control plane. Despite the
  helper name, `ensureDocumentPreview` resolves/creates worker preview jobs and
  does not render previews in Next.
- Revisit `/api/documents/[id]/parsed` GET. It still returns completed parsed
  JSON bytes through Next. If parsed artifacts can be large enough to matter,
  add a presign/redirect route and reserve this endpoint for short snapshots.
- Review `/api/documents/library/content` separately from cloud storage routes.
  It reads local library files into memory and returns bytes from Next; that may
  be desktop/self-host-only behavior, but the route should be clearly scoped as
  such or moved behind a more explicit local-library namespace.
- Review 300-second admin/maintenance routes
  `/api/admin/tasks/[key]/run`, `/api/admin/tasks/tick`, account deletion, and
  TTS segment clear for broad storage scans/deletes. Prefer queueing worker or
  maintenance tasks when cleanup can exceed a short control-plane request.
- Run final validation from a clean local state: `pnpm migrate`, `pnpm test:unit`,
  `pnpm exec tsc --noEmit`, and a `pnpm dev` startup smoke test.
- Optionally run the highest-value Playwright smoke path for upload/open/playback
  and audiobook MP3 export if the local worker/TTS provider is available.
