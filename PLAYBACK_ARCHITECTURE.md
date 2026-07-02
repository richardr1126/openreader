# TTS Playback Architecture

This is the current architecture for TTS playback across the browser client,
Next.js app, and compute worker. It reflects the cursor/session split, the move
from the mutable segment index/claim store to per-ordinal sidecars, and the
remaining client/worker ownership debt.

---

## Core rule

Classify playback state by `durability x write-frequency`, and do not use CAS in
the playback path.

| State | Home | Write model |
|---|---|---|
| Playback plan | S3, immutable plan object | write once |
| Segment audio | S3, content-addressed CBR MP3 under `tts_playback_segments_audio_v1/` | idempotent put |
| Segment duration/alignment/status | S3, one sidecar per plan ordinal | put to unique key |
| Session record | JetStream KV, `tts_playback.session.*` | plain `put` |
| Cursor/playhead | JetStream KV, `tts_playback.cursor.*` | plain `put`, last-write-wins |
| Jobs, op state, SSE events | JetStream streams | durable queue/events |

The important invariant is that hot cursor updates never rewrite the worker-owned
session record. Cursor writes happen on their own KV key, so a per-second browser
heartbeat, audio-range re-anchor, and worker status update cannot collide on one
revision. `kv.update(...revision)` should not appear in playback storage.

---

## Components

```
[Browser client] --HTTP--> [Next.js API routes] --HTTP--> [Compute worker]
  <audio> element             auth + proxy              Fastify routes
  projection loop                                      JetStream KV/streams
  scrubber/seek                                        S3 artifacts
```

The Next.js app remains a thin authenticated proxy. Playback ownership is split:
the client owns media/UI state, and the compute worker owns durable playback
state, artifact layout, generation, and stream construction.

That split is still too blurry for EPUB rendering/highlight behavior. The worker
is the authority for the durable plan and absolute ordinals, while the client
still derives rendered EPUB windows and keeps a viewport anchor for navigation.
Playback start no longer branches across EPUB CFI, viewport locator, selected
locator, text, segment key, or current index. The canonical worker plan is always
the playback identity source, and starting audio requires one absolute
worker-plan ordinal.

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
| Split cursor/session KV | Done | Cursor has its own key, session reads overlay it, all writes are plain `put`. |
| Delete claims and aggregate index | Done | Sidecars are keyed by ordinal under `tts_playback_segments_v1`; readiness comes from sidecar reads plus audio existence. |
| Stale sidecar recovery | Done | Generation validates completed sidecars against audio object existence, and the stream route retries stale sidecars whose audio object is missing. |
| EPUB selected-segment start | Done | Playback session creation now requires `startIntent.selectedOrdinal`; plan loading has no playback-start inputs. |
| Client controller extraction | Done | `useTtsPlayback` owns the audio ref, playback phase, session/timeline refs, session creation, audio event wiring, seek/resync, projection loop, foreground SSE sync, cursor heartbeat, visibility resync, playback time, and in-flight guard. |
| Collapse duplicate client state | Done | `useTtsPlaybackModel` owns worker plan, derived segments/sentences/current row, selected ordinal, and seek layout as one model. Array index is derived for display/navigation only. `playbackAnchor` is a reader viewport anchor. |
| Worker-plan ordinal start | Done | Playback jobs validate the selected ordinal against the canonical plan. Coordinate/text/key fallback resolution has been removed from the playback-start path. |
| Remove client-side EPUB playback planning | Done | Plan/session payloads no longer carry reader start coordinates, text, or segment keys. EPUB page extraction builds rendered text maps and a stable spine anchor only; playback segments come from the worker plan. |
| Clear cache as playback reset boundary | Done | Clear calls the worker reset endpoint before deleting objects; the worker bumps a scope epoch, cancels matching sessions, invalidates local sidecar caches, and epoch-aware readers/writers reject stale sidecars/late writes. |
| ID/key/schema consolidation | Done | Playback plan/grid/sidecar artifacts use `ordinal`; mirrored `sourceSegmentIndex` values are gone; plan/session request schemas are separated and strict; schema-version handling is centralized for playback plan artifacts and sidecars. |
| (7) Move playback audio to a dedicated prefix | Done | Generation writes audio through `buildTtsPlaybackSegmentAudioKey` under `tts_playback_segments_audio_v1/`, and sidecars point at that key. Playback no longer writes `tts_segments_v2/`. |
| (8) Retire legacy audiobook pipeline; download from worker loop | Done | Client/server audiobook pipeline, routes, hooks, blobstore, DB reads/writes, data export/claim/cleanup paths, and legacy tests are removed. Export now creates a document-extent playback session, tracks playback SSE progress, and downloads from the worker stream through the Next proxy. MP3 uses the worker stream directly when possible; M4B is a proxy-side AAC/MP4 transcode with chapter metadata derived from the worker plan/timeline. No audiobook blobstore. Legacy table DROP is complete in step 9. |
| (9) v5 decommission: drop legacy TTS + audiobook storage | Done | Dropped legacy table defs and generated per-dialect `DROP TABLE` migrations with the retired scheduled-task row delete. Deleted the recurring cleanup task, added idempotent `runV4Decommission(env)` for `tts_segments_v1/`, `tts_segments_v2/`, and `audiobooks_v1/`, wired it into bootstrap and `pnpm migrate-decommission`, removed the FS→S3 migrator, and updated current docs/config. |
| (10) Audiobook export hardening | Done | Export settings now expose audiobook speed and format, progress is driven by authoritative SSE `completedCount` snapshots, and MP3/M4B downloads use a same-origin Next proxy route. |

---

## Completed Work

### 1. Require Worker-Plan Ordinal for Audio Start

The client no longer starts playback from EPUB coordinates, locators, text,
segment keys, or viewport anchors. Audio start requires exactly one value:

- `startIntent.selectedOrdinal`

The worker validates the ordinal against the canonical plan and stores it as
`generationStartOrdinal`. The client should not independently choose between
`playbackSegment.ownerLocator`, `playbackAnchor.locator`, text, current index,
CFI, or page-start anchor.

Completed cleanup:

- Session creation is gated on `startIntent.selectedOrdinal`.
- The session request is rebuilt from the applied worker plan before starting
  audio.
- Worker playback-start resolution is ordinal-only.
- Plan/session payloads no longer send reader start coordinates, segment keys,
  or text as playback-start inputs.

### 2. Reduce Client EPUB Planning to Highlight Mapping

EPUB page extraction no longer builds client-side canonical playback windows.
The ownership division is:

- Worker: durable EPUB text extraction, segmentation, segment keys, locators,
  ordinals, and ordinal validation.
- Client: rendered text maps, CFI/page navigation, and mapping the current
  worker segment to a visible highlight.

Completed cleanup:

- Plan creation uses document/settings/segmentation input only; start page,
  spine offset, segment key, and text no longer fork plan operation keys.
- Playback sessions send plan identity plus selected worker-plan ordinal, not
  reader coordinates or text/key hints.
- EPUB page extraction builds rendered text maps plus a stable spine anchor only;
  worker-plan rows are mapped to those ranges for highlighting.

### 3. Extract the Playback Controller

`TTSContext` should be split so React context exposes state/actions, while a
smaller controller owns the playback state machine:

`idle -> planning -> ready -> playing -> seeking -> buffering -> ended/failed`

This controller should own the audio element, session lifecycle, seek/resync, and
projection loop. Document viewers should only provide anchors and render
highlight state.

Completed cleanup:

- `useTtsPlayback` now owns an explicit playback phase:
  `idle`, `planning`, `ready`, `playing`, `seeking`, `buffering`, `ended`, and
  `failed`.
- `useTtsPlayback` owns the unlocked audio ref, playback session ref, timeline
  ref, playback time, projection loop, foreground SSE sync, cursor heartbeat,
  visibility resync, and audio-seek readiness helper.
- Projection writes the selected worker-plan ordinal directly; it does not use a
  segment key, text, or ordinal-to-array-index cache.
- Stream creation, audio element event wiring, seek/resync polling, and the
  in-flight playback driver moved out of `TTSContext` into `useTtsPlayback`.
- `TTSContext` now passes plan-building callbacks into the controller and exposes
  state/actions.

### 4. Collapse Duplicate Client State

These values previously could disagree during cache clears, EPUB cursor moves,
and plan/session restarts:

- `playbackAnchor`
- `playbackSegments`
- `sentences`
- `currentIndex`
- `playbackSeekLayout`
- `playbackPlanRef`

The target is a single worker-plan model plus a selected ordinal. Derived views
compute sentence text, highlight segment, and scrubber row from that model.

Completed cleanup:

- Added `useTtsPlaybackModel` as the single client holder for the worker plan,
  canonical playback segments, derived sentence strings, selected ordinal, and
  seek layout.
- Removed direct `TTSContext` ownership of `sentences`, `playbackSegments`,
  `currentIndex`, `playbackSeekLayout`, and `playbackPlanRef`.
- Context values now read `currentSentence` and `currentSegment` from the model
  rather than indexing parallel arrays.
- The public context/API selection value is now `currentSentenceOrdinal`, and
  playback entrypoints take ordinals rather than array indexes or segment
  objects.
- Reader progress stores `segmentOrdinal`; saved positions no longer feed a
  sentence index into initial playback selection.
- Playback session creation uses the selected ordinal from the model. It does not
  synthesize a start ordinal from array index, text, segment key, or saved
  sentence position.

- `playbackAnchor` is now a reader viewport anchor. It can seed plan-backed UI
  selection after plan load, but it is not serialized into playback session
  start requests.

### 5. Fix Clear Cache to be a Playback Reset Boundary

Clear-cache is now an explicit playback reset before object deletion:

- The Next clear-cache path resolves the affected document/version scope and
  calls the compute worker reset endpoint before deleting audio or sidecar
  objects.
- The worker increments a durable cache epoch for the playback artifact scope.
  Sidecars, stream/timeline readers, and generation writes use that epoch to
  distinguish current artifacts from stale pre-clear artifacts.
- Matching `queued`, `running`, and `succeeded` playback sessions are marked
  `canceled` so active streams stop and running generation jobs observe
  cancellation at the existing pacing gate.
- Generation jobs capture their start epoch and re-check it before writing audio
  or sidecars, preventing late writes from recreating cleared artifacts.
- Worker route-side completed-sidecar caches are keyed by epoch and the reset
  endpoint drops local cache entries for the reset scope.
- The clear response reports the actual number of invalidated playback sessions.

### 6. Consolidate IDs, Keys, and Schemas

Playback identity is now ordinal-only across plan/grid/sidecar artifacts:

- Worker plan segments persist `ordinal`, `segmentKey`, text, and locator.
- Playback CBR layout inputs/slots use `ordinal`.
- Segment sidecars store `ordinal`, `segmentKey`, and `audioKey`; the sidecar
  reader validates schema version and the sidecar ordinal against the object key.
- `segmentEntryId` and persisted/client-facing `segmentId` fields were removed
  from playback entirely.
- Completed segment, timeline, and seek-layout rows expose `ordinal`; duplicated
  `sourceSegmentIndex` fields were removed.
- Plan-operation and playback-session request schemas are separate strict
  schemas instead of one loose shared payload shape.
- `segmentKey` remains the segmentation/content key from the canonical plan, and
  `audioContentHash` is only the worker-local audio/settings-specific hash used
  to build the content-addressed audio key.

### 7. Move Playback Audio to a Dedicated Playback-Owned Prefix

Playback generation now writes segment audio through
`buildTtsPlaybackSegmentAudioKey`:

`tts_playback_segments_audio_v1/[ns/<ns>/]users/<userId>/docs/<documentId>/<version>/<settingsHash>/<audioContentHash>.mp3`

The encoding is unchanged: generated audio still runs through `normalizeToMp3`
and `STREAM_AUDIO_PROFILE`. Only the object location moved. Existing
`tts_segments_v2/` playback cache objects are not copied; the first playback
after upgrade re-synthesizes into the playback-owned prefix as the accepted
hard-cut cost.

### 8. Retire the Legacy Audiobook Pipeline; Download from the Worker Loop

The legacy audiobook implementation is retired. Download/export now uses the
same canonical worker playback system as live playback:

- `AudiobookExportModal` creates a document-extent playback session through
  `TTSContext.startDocumentAudioExport`.
- Session creation sends `generationExtent: 'document'`, and the Next session
  route forces worker background extent to `document` for that export run.
- The worker persists `generationExtent` in playback session state and continues
  generation through the full forward plan even while the playback cursor is
  fresh. Normal listening sessions keep the sliding ahead-window behavior.
- Progress is the existing playback SSE stream. Audiobook export reads the
  authoritative `completedCount` / `plannedCount` snapshot; live playback can
  still use `completedThroughOrdinal` as a lightweight timeline wake-up.
- Download fetches the worker whole-document MP3 stream from the playback session
  audio route. MP3 output is a single CBR MP3 (`audio/mpeg`) assembled from
  completed playback sidecars/audio. M4B output is generated by the same Next
  proxy route as an AAC-in-MP4 (`audio/mp4`) transcode of that worker MP3 stream.
  The proxy derives chapter metadata from the canonical worker plan and playback
  grid, scaling chapter timestamps when audiobook speed changes. It finalizes a
  temporary `M4B`-branded MP4 before returning it so audiobook players do not
  receive a fragmented generic MP4. There is no separate audiobook blobstore.

Removed runtime surface:

- Remove `src/lib/client/audiobooks/`, `src/lib/server/audiobooks/`, the
  `src/app/api/audiobook/*` routes, `src/lib/client/api/audiobooks.ts`, and the
  audiobook-specific hooks (`useAudiobookStatus`, `useEPUBAudiobook`): done.
- Remove all app/runtime reads and writes of the `audiobooks` /
  `audiobookChapters` tables from claim, account export, account cleanup, query
  keys, client types, and test teardown: done.
- Delete the legacy audiobook tests and replace coverage with playback-export
  contract checks: done.
- Table definitions are removed from the live schema. Migration history remains
  only so older installs can apply the step-9 DROP migration. The separate
  `audiobooks_v1/` object prefix is dead runtime storage and is purged by the
  v4 decommission routine.

Decided:

- **Formats: MP3 and M4B.** Download serves the worker's existing CBR-MP3
  whole-document route for MP3 when possible. M4B is supported by the same
  same-origin download proxy as an MP3->AAC/MP4 transcode using `ffmpeg-static`,
  finalized in temporary storage with `M4B` branding and chapter atoms before
  download. The legacy m4b export job remains dropped: no durable second stored
  artifact and no `audiobooks_v1/` runtime storage. Richer chapter titles remain
  feasible later if the playback plan starts persisting source titles, but that
  would be a plan-artifact enhancement rather than a fallback to the retired
  pipeline.
- **No eager/gap-fill fork.** Download requests `extent: 'document'`; generation is
  idempotent (the "Generate Segments" flow short-circuits on `objectExists(audioKey)`
  / completed sidecar), so it only fills missing ordinals. "Done" = every plan
  ordinal has a completed sidecar. There is no separate eager-vs-reuse mode.

---

### 9. v5 Decommission: Drop Legacy TTS + Audiobook Storage

The v5 decommission is complete. The table drop and object purge remain separate
ownership domains:

- Drizzle migration `0015_cleanup_pre_v5` drops `tts_playback_sessions`,
  `tts_segment_entries`, `tts_segment_variants`, `audiobooks`, and
  `audiobook_chapters`, and deletes the retired
  `cleanup-legacy-tts-playback-cache` scheduled-task row.
- The recurring `cleanup-legacy-tts-playback-cache` task and handler are gone.
- `packages/bootstrap/src/decommission-v4.mjs` exports idempotent
  `runV4Decommission(env)`, which prefix-purges only `tts_segments_v1/`,
  `tts_segments_v2/`, and `audiobooks_v1/`.
- Self-hosted startup runs the decommission inline after DB migrations when S3 is
  configured; serverless/manual deploys can run `pnpm migrate-decommission`.
- The old FS→S3 migrator (`storage-migration.mjs`, `migrate-fs`, and
  `openreader-migrate-storage`) is removed.
- Clear-cache and account-delete cleanup now target v5 playback audio/sidecar
  prefixes, not retired `tts_segments_v*` roots.

Verified during implementation:

- `pnpm migrate` succeeds after the corrected SQLite statement split/string
  literal in `0015_cleanup_pre_v5`.
- `pnpm dev` reaches Next "Ready" after migrations and the v4 decommission.
- Full unit suite passes.

---

### 10. Audiobook Export Hardening

The worker-backed audiobook export hardening pass is complete:

- `AudiobookExportModal` now exposes audiobook speed and output format in the
  export settings alongside native model speed. For `1x` MP3 downloads the proxy
  streams the worker MP3 unchanged; for other MP3 speeds it applies an ffmpeg
  `atempo` transform during download so the exported MP3 itself changes speed.
  M4B downloads always transcode the worker MP3 stream to a finalized
  M4B-branded AAC/MP4 file with chapter metadata and apply the same tempo
  transform when needed.
- Export progress no longer relies on the SSE ordinal watermark for the visible
  count and no longer polls seek-layout. The worker emits `completedCount` from
  generated sidecar state, including segments generated by prior live playback
  sessions, so the modal can render progress directly from SSE snapshots.
- The seek-layout route remains the playback grid API for live playback,
  scrubber/seek state, and generated-region timing. Audiobook progress does not
  depend on it.
- Session creation returns a same-origin download URL at
  `/api/tts/stream/[sessionId]/audio`.
- The new Next audio route resolves/authenticates the playback session, mints the
  worker playback token server-side, proxies the MP3 stream, forwards range/audio
  headers for raw MP3 downloads, optionally transcodes tempo for non-`1x`
  audiobook speed, derives M4B chapters from the worker plan/grid, transcodes M4B
  as AAC/MP4 with ffmetadata chapters, and sets `Content-Disposition`.
- The modal downloads through that same-origin route by clicking a link instead
  of fetching the entire MP3 into a browser Blob, avoiding CORS/public-worker URL
  reachability and large-Blob failure modes.

Verified during implementation:

- `pnpm exec tsc --noEmit`
- Focused UI/architecture tests for audiobook export, shared controls, and route
  error contracts.
- Focused playback/worker tests for request parsing, tokens, playback grids,
  compute-worker client contracts, worker routes, derivation, audio layout, and
  playback storage.

---

## Remaining Work

### 11. Idempotent Playback Jobs and Shared Generation Cache

Status: done. This is a hard cut for the unmerged playback v1 branch: there is
no random playback-session fallback, no legacy playback operation-key shape, and
no compatibility shim for generation without a canonical plan artifact.

The playback/export cache is durable and document-scoped, but live playback and
audiobook export are different UX/job concerns. They must reuse the same segment
audio without sharing one mutable session record for cursor state, export state,
and active operation ownership.

Target model:

- Sessions are UX state. A live playback session owns live cursor/playback
  state. An audiobook export session owns export progress/download state. They
  are separate deterministic session ids for the same document/settings scope.
- Jobs are idempotent work requests. Repeating the same export Generate click
  reuses the same document-extent operation. Live cursor continuations reuse a
  stable operation key for the same cursor/run intent instead of minting a new
  random job every time.
- The segment cache is shared. Both live and export read/write sidecars under
  `storageUserId + documentId + documentVersion + settingsHash + ordinal`, so
  previously generated live audio is skipped by export and vice versa.
- The cache write boundary is per ordinal. A `generating` sidecar is only a
  short-lived lease for one missing segment. It is not the session model and it
  does not make live playback and export share cursor state.
- Live playback may use admin background extent (`section` or `document`) within
  the live session. Audiobook export is always a separate document-extent job
  whose final output begins at ordinal `0`.
- Export progress is the true completed segment count across the whole plan,
  not a contiguous prefix and not only what one browser tab has streamed.

Implementation plan:

1. Define a shared canonical playback scope helper. It includes every input that
   changes generated audio or segmentation (`storageUserId`, document identity,
   reader type, `settingsHash`, and `planObjectKey`) and excludes cursor/UI
   attempt state.
2. Derive deterministic session ids from that scope plus `purpose`:
   `live` for playback and `export-document` for audiobook export. Do not use one
   shared session for both.
3. Change playback operation keys to include canonical scope + generation intent.
   Document export uses one stable operation key per export session/scope. Live
   continuations keep a run id only for actual cursor/window continuations.
4. Keep session creation idempotent by overwriting/refreshing the deterministic
   session record for that purpose while preserving the split cursor key behavior.
5. Add ordinal-level generation leases using the sidecar object as the durable
   coordination point. A lease records owner id, cache epoch, updated time, and
   expected audio key. Completed sidecars remain immutable; stale leases are
   safely stealable after a timeout.
6. In generation, before synthesis:
   - If audio exists, self-heal sidecar and continue.
   - If completed sidecar exists, continue.
   - If a fresh foreign `generating` lease exists for the expected audio key,
     wait/backoff and re-read until completed, terminal, canceled, or stale.
   - If no fresh lease exists, write/refresh the lease and synthesize.
7. Make document export completion session-agnostic: a document-extent operation
   succeeds when every plan ordinal is completed or terminally errored for the
   shared cache scope.
8. Add regression coverage:
   - repeated audiobook Generate with the same scope returns the same session/op;
   - live and export use different session ids for the same cache scope;
   - live playback then export skips completed segments;
   - export and live playback overlapping on a missing ordinal do not duplicate
     synthesis when a fresh lease exists;
   - stale lease recovery still regenerates.
9. Update `PLAYBACK_ARCHITECTURE.md` invariants after implementation to remove
   the old "two workers racing is wasteful but correct" allowance from normal
   operation. The fallback can remain true only for pathological lease races,
   not as the intended concurrency model.

Implemented notes:

- Next session creation requires `planObjectKey` and derives deterministic
  session ids from canonical scope plus purpose: `live` or `export-document`.
- Worker session creation writes `generationStartOrdinal` and cursor state from
  the required `planning.selectedOrdinal`; live playback must never initialize
  from ordinal `0` unless the selected plan ordinal is actually `0`.
- Worker playback operation keys remain `tts_playback|v1` but now use canonical
  scope hash + session id + generation intent. Active jobs dedupe; terminal
  playback jobs are replaceable so a fresh request verifies current cache state.
- Audiobook export does not mutate the live selected ordinal/cursor. Its session
  starts output at ordinal `0` and runs document extent over the whole plan.
- Segment sidecars now carry optional lease owner/update fields. Fresh foreign
  `generating` leases are waited on; stale leases are stealable.
- Full-document generation is not stopped by live cursor floor logic.

### 12. Final Cleanup Pass Before Merge

After step 10 is verified, the last pass is release hygiene:

- Run a final repo scan for runtime references to dropped symbols and routes:
  `ttsPlaybackSessions`, `ttsSegmentEntries`, `ttsSegmentVariants`,
  `audiobookChapters`, `/api/audiobook`, `cleanup-legacy-tts-playback-cache`,
  `migrate-fs`, and `openreader-migrate-storage`. Migration history, frozen
  versioned docs, and decommission docs are allowed exceptions.
- Run final validation from a clean local state: `pnpm migrate`, `pnpm test:unit`,
  `pnpm exec tsc --noEmit`, and a `pnpm dev` startup smoke test.
- Optionally run the highest-value Playwright smoke path for upload/open/playback
  and audiobook MP3 export if the local worker/TTS provider is available.
