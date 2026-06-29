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

What changes in v5 is *where playback stores it*. Today the worker reuses
`buildTtsSegmentAudioKey` → `tts_segments_v2/`, the same audio prefix the pre-refactor
system on `main` used (the old DB-backed TTS tables that paired with it are already
dead code on this branch). Playback gets its own content-addressed prefix so the v5
artifact set is self-contained and the inherited `tts_segments_v2/` prefix can be
dropped wholesale:

`tts_playback_segments_audio_v1/[ns/<ns>/]users/<userId>/docs/<documentId>/<version>/<settingsHash>/<segmentId>.mp3`

This sits beside the sidecar prefix rather than inside it on purpose: audio is keyed
by content (`settingsHash + segmentId`) for cross-ordinal/session dedup, while
sidecars are keyed per ordinal. Both are v5-owned and are cleared together as one
document/settings scope on clear-cache.

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

## Client State Today

`TTSContext` now exposes playback state/actions and owns document/config inputs
that are outside the media controller:

- Playback plan request construction through the Next proxy.
- Settings mutations for voice, speed, provider, language, and PDF skip kinds.
- Segment/word highlight state and current document anchor.
- EPUB cursor-follow navigation guards.

`useTtsPlayback` owns:

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
| ID/key/schema consolidation | In progress | Plan/session payloads are now separated and legacy start key/text/coordinate inputs were removed from the worker playback operation schema. Remaining overlap: `segmentIndex`/`ordinal`, `segmentKey`/`segmentId`, and duplicated normalizers. |
| (7) Move playback audio to a dedicated prefix | Not done | Audio is **already** CBR (`normalizeToMp3`/`STREAM_AUDIO_PROFILE`) — encoding unchanged. Add a key builder writing a new content-addressed prefix `tts_playback_segments_audio_v1/`; point generation + sidecar `audioKey` at it; stop writing `tts_segments_v2/`. Accepted cost: cached audio re-synthesizes once into the new prefix. Unblocks v2 retirement (9), so it lands first. |
| (8) Retire legacy audiobook pipeline; download from worker loop | Not done | Remove the client/server audiobook pipeline, routes, and blobstore, and stop all reads/writes of the audiobook DB tables. Download drives the worker full-document loop (`extent: 'document'`), tracks progress over playback SSE, and fetches the worker-assembled audio (already CBR) from S3 — **MP3 only**, m4b+chapters deferred; no second ffmpeg stitch or blobstore. Independent of step 7. (Table DROP itself happens in step 9.) |
| (9) v5 decommission: drop legacy TTS + audiobook storage | Not done | (A) Remove the five table defs (`tts_playback_sessions`, `tts_segment_entries`, `tts_segment_variants`, `audiobooks`, `audiobook_chapters`; keep `user_tts_chars`) and `drizzle-kit generate` a `DROP TABLE` migration per dialect (+ hand-add `DELETE FROM scheduled_tasks WHERE key='cleanup-legacy-tts-playback-cache'`). (B) **Delete** the recurring `cleanup-legacy-tts-playback-cache` task + handler; add an idempotent `runV4Decommission(env)` that prefix-purges `tts_segments_v1/` + `tts_segments_v2/` + `audiobooks_v1/` (never `tts_playback_*`), run both inline at self-hosted boot (`cli.mjs`) and as `pnpm migrate-decommission` for Vercel/CI. (C) Remove the dead `migrate-fs` FS→S3 migrator; the decommission takes its boot slot. Gated on steps 7 + 8. |

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

---

## Remaining Work

### 6. Consolidate IDs, Keys, and Schemas

The playback path still carries too many overlapping identity fields and parallel
schema definitions. This makes the code harder to reason about and keeps
transitional naming alive after ordinals became the playback identity.

Target identity model:

- `ordinal`: the canonical worker-plan position and only playback cursor/start
  identity.
- `segmentKey`: stable segmentation/content key from the canonical plan, used for
  dedupe/debugging, not for playback start.
- `segmentId`: audio/settings-specific synthesized segment identity, used for
  content-addressed audio and sidecar metadata.
- `planObjectKey`: durable S3 address of the immutable canonical plan.
- `planSignature`: segmentation-shape hash used to address/reuse the plan.
- `settingsHash`: audio/settings hash used for generated audio and sidecars.

Required cleanup:

- Rename internal `segmentIndex` fields on playback plan/grid artifacts to
  `ordinal` without keeping parallel playback identities.
- Remove duplicated `sourceSegmentIndex` values where they only mirror `ordinal`.
- Keep `segmentKey` and `segmentId` separate and document where each is allowed.
- Consolidate plan/session request schemas so plan loading and playback session
  creation do not share one loose payload type.
- Consolidate generated/hand-written response normalizers for plan, grid, seek
  layout, and timeline rows.
- Add schema-version handling helpers for playback plan artifacts and sidecars
  instead of scattered `schemaVersion: 1` checks.
- Add tests that reject ambiguous identity input, such as session starts without
  `ordinal`, rows with conflicting `ordinal`/`segmentIndex`, or sidecars whose
  ordinal does not match their object key.

### 7. Move Playback Audio to a Dedicated Playback-Owned Prefix

The encoding is *not* the issue here — segment audio is already CBR. Every segment
is run through `normalizeToMp3` → `STREAM_AUDIO_PROFILE` (44.1 kHz mono, 128 kbps
CBR, Xing stripped) in `packages/tts/src/audio-format.ts` before storage, which is
what makes the whole-document stream byte↔time linear and seekable. This step does
not change that profile.

The problem is *location*: the worker (`handlers.ts`, its only writer on this branch)
reuses `buildTtsSegmentAudioKey` (`packages/tts/src/segments.ts`) → `tts_segments_v2/`,
the same prefix the pre-refactor system on `main` used. Because v5 playback audio
lands in that inherited prefix, `tts_segments_v2/` cannot be dropped without taking
live playback audio with it. Give playback its own content-addressed prefix so its
artifacts are self-contained, then v2 becomes purgeable. This unblocks step 9, so it
lands first.

- Add a dedicated key builder (e.g. `buildTtsPlaybackSegmentAudioKey`) writing the
  content-addressed key
  `tts_playback_segments_audio_v1/[ns/<ns>/]users/<userId>/docs/<documentId>/<version>/<settingsHash>/<segmentId>.mp3`.
  Keep the existing content-addressing (`settingsHash + segmentId`) and the existing
  `normalizeToMp3` CBR encoding unchanged — only the prefix moves.
- Point the generation flow ("Generate Segments") and the sidecar `audioKey` at the
  new builder. Stream/seek-layout readers consume audio only via the sidecar
  `audioKey`, so they need no prefix knowledge.
- Stop writing `tts_segments_v2/` from the playback path entirely.

Accepted cost: existing `v2` objects are **not** copied/migrated. They hold
identical CBR bytes, but content-addressing keys them under the old prefix, so the
first playback after upgrade re-synthesizes each segment into the new prefix — a
one-time re-encode that incurs real TTS-provider cost across the cached library.
This churn is the deliberate price for a clean ownership/decommission boundary
(chosen over keeping `tts_segments_v2` as the audio store).

### 8. Retire the Legacy Audiobook Pipeline; Download from the Worker Loop

There are currently two unrelated generation systems. The new playback system
(plan + content-addressed segment audio + per-ordinal sidecars + SSE) already owns
whole-document generation: the worker background loop is bounded by `extent`
(`'section'` | `'document'`, admin setting `ttsPlaybackBackgroundExtent`), and the
audio route already assembles a whole-document MP3 from the plan plus completed
sidecars. The legacy "audiobook" path is a separate, client-driven pipeline that
duplicates all of this with its own storage, schema, and ffmpeg stitching:

- `src/lib/client/audiobooks/` (`pipeline.ts` + `adapters/{epub,pdf,html}.ts`) and
  `src/lib/client/api/audiobooks.ts`.
- `src/app/api/audiobook/route.ts`, `.../audiobook/chapter/route.ts`,
  `.../audiobook/status/route.ts`.
- `src/lib/server/audiobooks/` (`blobstore.ts`, `chapters.ts`, `ffmpeg-bin.ts`,
  `prune.ts`, `settings.ts`) and the separate audiobook blob prefix.
- DB tables `audiobooks` / `audiobookChapters`.
- `AudiobookExportModal.tsx`, `useAudiobookStatus`, `useEPUBAudiobook`, and the
  audiobook-specific query keys / client types.

This path re-segments the document on the client, generates TTS per chapter into a
separate blobstore, and stitches with server-side ffmpeg. None of it shares the
canonical worker plan, content-addressed dedup, or sidecar readiness, so audio
generated for playback is regenerated again for download.

Target: "download" is just the worker full-document loop plus a fetch.

- Reuse the canonical plan. Download must not re-extract or re-segment on the
  client; it operates on the same worker-plan ordinals as playback.
- Drive generation by requesting `extent: 'document'` for the document/settings
  scope. This is independent of the admin background-extent default, which only
  bounds *background* reach during playback; a download forces full-document reach.
- Track progress via the existing playback SSE events stream — the worker already
  emits `TtsPlaybackProgress` (`completedThroughOrdinal` / `plannedCount`) — not a
  separate audiobook status table/poll.
- Download the assembled audio from S3 via the worker whole-document audio route
  once the document scope is fully generated. Segments are already CBR MP3
  (`STREAM_AUDIO_PROFILE`), so the audio route frames/concats them into one
  byte↔time-linear file with no second ffmpeg stitching stage and no second
  blobstore. Readers reach audio via the sidecar `audioKey`, so this works
  regardless of which prefix step 7 lands on — step 8 does not depend on step 7.
- Download output is a single CBR MP3 (`audio/mpeg`) — the exact bytes the worker
  audio route already serves. No chapter markers (MP3 has no portable chapter
  container) and no client-side section assembly.

Required cleanup:

- Remove `src/lib/client/audiobooks/`, `src/lib/server/audiobooks/`, the
  `src/app/api/audiobook/*` routes, `src/lib/client/api/audiobooks.ts`, and the
  audiobook-specific hooks (`useAudiobookStatus`, `useEPUBAudiobook`).
- Rebuild `AudiobookExportModal` as a thin download UI over the playback model:
  request document-extent generation, render SSE progress, then offer the
  worker-assembled file.
- Stop all reads/writes of the `audiobooks` / `audiobookChapters` tables and the
  separate audiobook blob prefix; fold prune/cleanup into the playback artifact
  lifecycle (and the clear-cache reset boundary). The actual table DROP and object
  purge happen in the decommission (step 9), not here — this step just makes them
  dead.
- Remove audiobook entries from query keys, client types, data export/cleanup, and
  the legacy audiobook tests, replacing coverage with whole-document
  generation/download tests against the worker loop.

Decided:

- **Format: MP3 only.** Download serves the worker's existing CBR-MP3 whole-document
  route; the legacy m4b-with-chapters export is dropped. Native m4b+chapters is
  feasible later (the section map + sidecar durations yield chapter timestamps, and
  `ffmpeg-static` is bundled) but is a *separate* export job — a full MP3→AAC
  re-encode plus MP4 chapter-atom muxing, distinct from the byte-range MP3 route — so
  it is explicitly out of scope for v5, not a fallback path.
- **No eager/gap-fill fork.** Download requests `extent: 'document'`; generation is
  idempotent (the "Generate Segments" flow short-circuits on `objectExists(audioKey)`
  / completed sidecar), so it only fills missing ordinals. "Done" = every plan
  ordinal has a completed sidecar. There is no separate eager-vs-reuse mode.

### 9. v5 Decommission: One-Shot Drop of Legacy TTS + Audiobook Storage

Two independent jobs with clean ownership: **the Drizzle migration drops the tables;
a one-shot operator-run CLI purges the object storage.** They do not depend on each
other and must not be merged into one "cleanup" path. The recurring
`cleanup-legacy-tts-playback-cache` task is **deleted outright** — no metadata-free
survivor, no permanent no-op sweep.

Today both responsibilities are tangled inside that recurring task
(`src/lib/server/tasks/registry.ts` → `handlers/cleanup-legacy-tts-playback-cache.ts`):
it `db.delete(...)`s `tts_segment_variants`, `tts_segment_entries`, and
`tts_playback_sessions`, and it deletes the `tts_segments_v1/` and `tts_segments_v2/`
object prefixes, on a 24h schedule. Because the handler imports the Drizzle table
defs, those tables can never be removed from the schema while it exists.

#### A. Table drop = a generated Drizzle migration

The schema migration is the only thing that removes tables. Do not delete rows from
application/task code.

- Remove the table definitions from `packages/database/src/schema_postgres.ts` and
  `packages/database/src/schema_sqlite.ts` (re-exported via `schema.ts`):
  `ttsPlaybackSessions`, `ttsSegmentEntries`, `ttsSegmentVariants`, `audiobooks`,
  `audiobookChapters`. Keep `userTtsChars` — it backs live usage counters via
  `prune-tts-usage`.
- Generate the migration with `drizzle-kit generate` for both dialects
  (`drizzle.config.pg.ts`, `drizzle.config.sqlite.ts`), producing matching
  `DROP TABLE` migrations under `packages/database/migrations/postgres/` and
  `packages/database/migrations/sqlite/`. Review the generated SQL — these must be
  `DROP TABLE` only, with no unintended drops from concurrent schema edits.
- These migrations apply through the normal runner (`pnpm --filter
  @openreader/database migrate` → `bin/migrate.mjs` → `runMigrations` → drizzle
  `migrate()`), so v4→v5 drops the tables exactly once as part of the standard
  upgrade. Drizzle's forward-only journal is what makes "keep the tables for older
  upgraders" unnecessary: an instance only reaches v5 by applying this migration,
  so no v5 build ever sees the tables.

Fold one data statement into this migration: `DELETE FROM scheduled_tasks WHERE key
= 'cleanup-legacy-tts-playback-cache'`, so retiring the task leaves no orphan row.
(`drizzle-kit generate` only emits schema DDL, so add this line to the generated
migration by hand.)

#### B. Object purge = an idempotent decommission step (boot + CLI)

S3 objects cannot be deleted by a SQL migration, and after step A the row keys are
gone anyway — so the object purge is a standalone idempotent routine that works
purely by prefix and never reads the dropped tables. It takes the boot slot the
legacy `migrate-fs` step used to occupy (see C) and replaces the recurring task.

Once v5 playback writes its audio under its own prefix
`tts_playback_segments_audio_v1/` (step 7), `tts_segments_v2/` becomes legacy along
with `tts_segments_v1/`. Both `tts_segments_v{1,2}/` are purged; the new playback
audio + sidecar + plan prefixes are kept. (The bytes in `v2` are CBR and fine — they
are deleted because nothing references that prefix anymore, not because of any
encoding problem.)

**Sequencing precondition:** the worker is currently the *only* writer of
`tts_segments_v2/` (the old DB-backed TTS path is already dead code), so the single
gate is step 7: once playback synthesis writes the new prefix instead, nothing reads
`v2` and it can be purged. Until that prefix move lands, deleting `v2` would wipe
live playback audio. So this purge is gated on step 7, not the audiobook retirement
(step 8).

Exact prefixes (all relative to `${getS3Config().prefix}/`):

- DELETE `tts_segments_v1/` — legacy audio format, no longer written.
- DELETE `tts_segments_v2/` — CBR audio prefix inherited from the pre-v5 system; the
  worker stops writing it after the step-7 prefix move, so nothing references it.
- DELETE the audiobook prefix `audiobooks_v1/` (`audiobookPrefix` in
  `src/lib/server/audiobooks/blobstore.ts` →
  `${prefix}/audiobooks_v1/[ns/<ns>/]users/<userId>/<bookId>-audiobook/`); deleting
  at the `audiobooks_v1/` root covers every namespace/user/book.
- KEEP `tts_playback_segments_audio_v1/` (new CBR playback audio),
  `tts_playback_segments_v1/` (sidecars), `tts_playback_plan_v1/` (plans), and
  `tts_playback_v1/` (session plan/timeline). None of these are legacy.

Spec:

- New bootstrap module `packages/bootstrap/src/decommission-v4.mjs` exporting an
  idempotent `runV4Decommission(env)`. Prefix purge (relative to
  `${getS3Config().prefix}/`): list + batch-delete under `tts_segments_v1/`,
  `tts_segments_v2/`, and `audiobooks_v1/`. Empty prefixes ⇒ no-op (3 cheap `LIST`s),
  so it is safe to run on every boot. Do **not** touch any `tts_playback_*` prefix.
- **Two triggers, one routine — exactly mirroring how DB migrations run today:**
  - **Self-hosted = automatic in bootstrap:** `cli.mjs` calls `runV4Decommission(env)`
    inline (an imported function, not a `spawnSync` subprocess like the old migrator),
    right after `runDbMigrations` and behind the same S3-configured guard the storage
    migration used. The operator does nothing extra — same as `pnpm migrate` already
    runs automatically here.
  - **Serverless (Vercel) = run manually:** `cli.mjs` does not run there, so the
    routine is also exposed as `pnpm migrate-decommission` (root `package.json`) + a
    bin (`openreader-decommission-v4`), which the operator runs once at the v5 deploy
    — the same manual step they already do for `pnpm migrate`.
- Idempotency is the run-once mechanism: no marker/state needed. The routine lists
  each prefix and deletes what is there; once the prefixes are empty every later boot
  is a no-op (3 empty `LIST`s, zero deletes), so running it on every boot is safe.
- Delete the recurring task: remove `cleanup-legacy-tts-playback-cache` from
  `TASK_REGISTRY` and delete `handlers/cleanup-legacy-tts-playback-cache.ts`. The
  `scheduled_tasks` row is removed by the step-A migration.

#### C. Also remove the legacy `migrate-fs` FS→S3 migration

The filesystem storage backend is long retired, so its one-time migrator is dead
weight and is removed in the same change — the decommission routine takes its boot
slot:

- Delete `packages/bootstrap/src/storage-migration.mjs`.
- In `packages/bootstrap/src/cli.mjs`, replace the `runStorageMigrations()`
  `spawnSync` step (the `Running storage migrations (v2)…` block, kept behind the
  same `S3 configuration is incomplete` guard) with an inline
  `await runV4Decommission(env)` call from the new module. DB migrations still run
  first, then the decommission.
- Drop the `openreader-migrate-storage` bin and `migrate-storage` script from
  `packages/bootstrap/package.json`, and the `migrate-fs` / `migrate-fs:dry-run`
  scripts from root `package.json`. Prune now-unused bootstrap deps (`ffmpeg-static`;
  keep `pg`/`better-sqlite3`/`@aws-sdk/client-s3` for the decommission CLI).
- Update the current (non-versioned) docs that mention `migrate-fs`:
  `docs-site/docs/configure/migrations.md`,
  `docs-site/docs/deploy/vercel-deployment.md`,
  `docs-site/docs/deploy/local-development.md`. Leave `versioned_docs/*` frozen.

Sequencing:

- Must land *after* step 7 (playback writes audio to the new prefix so
  `tts_segments_v2/` is no longer referenced) and *after* step 8 (nothing writes
  audiobook tables/blobs) — otherwise the purge deletes live data.
- v4→v5 is a one-way decommission: the Drizzle migrator applies migrations forward
  in journal order, so any supported v4 schema upgrades cleanly; there is no down
  migration and the dropped tables are not recreated.
