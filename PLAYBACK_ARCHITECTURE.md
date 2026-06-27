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
| Segment audio | S3, content-addressed MP3 object | idempotent put |
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

That split is still too blurry for EPUB start/resume behavior. The worker is the
authority for the durable plan and absolute ordinals, but the client still derives
rendered EPUB windows, tracks a selected segment index, keeps a viewport anchor,
and has legacy paths that can send coordinates/text back to the worker. Those
paths are architecture debt. Playback start must not branch across EPUB CFI,
viewport locator, selected locator, text, and current index. The canonical worker
plan is always the playback identity source, and starting audio requires one
absolute worker-plan ordinal.

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

`TTSContext` is still the transitional media/UI controller. It currently owns:

- One unlocked `<audio>` element and its event handlers.
- Playback plan/session creation through the Next proxy.
- Timeline refresh and playback projection from `audio.currentTime`.
- Segment/word highlight state and current document anchor.
- Seek and resync logic for generated and not-yet-generated regions.
- EPUB cursor-follow navigation guards.
- Restart behavior for voice, speed, provider, and segmentation changes.

For EPUB specifically, the client also still does too much:

- It builds a rendered-page window into the EPUB chapter text.
- It materializes client-side canonical segments for highlighting and navigation.
- It tracks both a viewport/page-start anchor and a selected segment/index.
- It can still initiate playback through legacy locator/anchor fallback paths
  instead of requiring a selected worker-plan ordinal.
- It keeps worker plan rows, local current index, seek-layout rows, highlight
  state, and page navigation state in separate pieces of React state.

The latest fix makes EPUB start requests carry a selected worker-plan ordinal
when available. That is only a transitional patch. The final architecture must
delete the fallback paths instead of making them slightly less wrong.

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
  not playback-start fallbacks.
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
| EPUB selected-segment start | Done | Playback session creation now requires `startIntent.selectedOrdinal`; plan loading remains separate. |
| Client controller extraction | Not done | `TTSContext` still contains the playback driver, projection, seek/resync, and restart behavior. |
| Worker-plan ordinal start | Done | Playback jobs validate the selected ordinal against the canonical plan. Coordinate/text fallback resolution has been removed from the playback-start path. |
| Remove client-side EPUB playback planning | Not done | EPUB rendered-window planning should be reduced to view/highlight mapping; durable segment identity and ordinal selection should live with the worker plan. |

---

## Remaining Work

### 1. Require Worker-Plan Ordinal for Audio Start

The client should stop starting playback from EPUB coordinates, locators, text,
segment keys, or viewport anchors. Audio start requires exactly one value:

- `startIntent.selectedOrdinal`

The worker validates the ordinal against the canonical plan and stores it as
`generationStartOrdinal`. The client should not independently choose between
`playbackSegment.ownerLocator`, `playbackAnchor.locator`, text, current index,
CFI, or page-start anchor.

Required cleanup:

- Keep playback session creation gated on `startIntent.selectedOrdinal`.
- Keep the session request rebuilt from the applied worker plan before starting
  audio.
- Keep worker playback-start resolution ordinal-only.
- Continue shrinking client start-index mapping until it is only UI selection
  mapping, not playback authority.

### 2. Reduce Client EPUB Planning to Highlight Mapping

The client still builds canonical EPUB windows to bridge rendered text to
highlight ranges. That should not also be a playback planning path. The target
division is:

- Worker: durable EPUB text extraction, segmentation, segment keys, locators,
  ordinals, and ordinal validation.
- Client: rendered text maps, CFI/page navigation, and mapping the current
  worker segment to a visible highlight.

### 3. Extract the Playback Controller

`TTSContext` should be split so React context exposes state/actions, while a
smaller controller owns the playback state machine:

`idle -> planning -> ready -> playing -> seeking -> buffering -> ended/failed`

This controller should own the audio element, session lifecycle, seek/resync, and
projection loop. Document viewers should only provide anchors and render
highlight state.

### 4. Collapse Duplicate Client State

These values can currently disagree during cache clears, EPUB cursor moves, and
plan/session restarts:

- `playbackAnchor`
- `playbackSegments`
- `sentences`
- `currentIndex`
- `playbackSeekLayout`
- `playbackPlanRef`

The target is a single worker-plan model plus a selected ordinal. Derived views
compute sentence text, highlight segment, and scrubber row from that model.

### 5. Add Regression Coverage for EPUB Prefix Starts

Add a test case where an EPUB chapter/page begins with prefix text such as a
chapter number or image alt text, then playback starts from the first real
sentence after the prefix. The expected behavior is:

- playback session creation sends the selected worker-plan ordinal
- no prefix segment is synthesized or played before it
- highlight and audio begin on the same segment before and after refresh
