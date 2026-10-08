# Audiobook export reliability and playback startup performance

Status: iOS parity is merged. Audiobook fixes are implemented on
`codex/audiobook-export-reliability`, based on merged `main` (`18e77ba9`).
Normal playback startup fixes are also implemented on that same branch, with
combined local validation complete. The earlier
combined worktree has been removed; its investigation snapshot remains archived.

This document describes two separate work areas on the same
`codex/audiobook-export-reliability` branch and pull request, each with its own
acceptance criteria and validation. Shared cache mechanisms do not make
audiobook exports and interactive playback one lifecycle.

## Work 1: Audiobook export reliability

Branch: `codex/audiobook-export-reliability`.

### User-visible problems

- A previously downloadable MP3/M4B became unavailable while its source segment
  audio remained cached.
- Selecting Start then showed `2234/2234 segments 100%` for several minutes
  before switching to Building MP3. The rebuilt file eventually became ready.
  This is a disappearance followed by slow preparation for assembly, not a
  confirmed permanent deadlock.
- A later existing-export lookup took about five seconds without loading
  feedback. Start and Stop also appear slow to respond.
- The UI does not clearly distinguish checking cached audio, generating missing
  audio, assembling a file, transcoding, uploading, and a downloadable result.
- Document settings can fail with “Failed to measure document storage”, leaving
  sizes unresolved and no retry. Investigate the worker route/version and remote
  storage failure, add loading/retry feedback, and validate export accounting.
  The reported production failure was confirmed as a web/worker version mismatch:
  after deploying the merged worker and reloading, the owner confirmed sizes
  display correctly. Retain the loading/retry and clearer error improvements.

### Investigation findings

1. Final MP3/M4B files and ready metadata sidecars are uploaded to object storage
   by `packages/compute-worker/src/jobs/playback/export-job.ts`. They are not
   stored only in memory.
2. Before this branch, `src/lib/server/tasks/handlers/expire-export-artifacts.ts` applied a hard-coded
   seven-day retention window to both audiobook files and account export ZIPs.
   The maintenance task defaults to a daily run. Expiry is based on completed
   artifact `createdAt`; downloads do not extend it. Segment audio has separate
   retention. This is a concrete deletion mechanism; confirming that it removed
   this particular file requires its metadata or cleanup history.
3. Signed download URLs expire after five minutes. Each authenticated download
   request gets a fresh URL. This is separate from final-file retention and the
   live playback session's 30-minute expiry.
4. Document generation discovers and counts cached sidecars before verifying
   each source. The counter can already be 100% while that verification runs.
   `generateExplicitTtsPlaybackSegments` also waits for ordered word alignment
   to drain before the document job marks its session succeeded. Whole-book
   assembly is gated on that session state, although MP3/M4B construction does
   not consume word alignment.
5. `src/app/api/tts/export/resolve/route.ts` reads full chapter progress before
   handling Stop or discovering the artifact, and reads progress again after
   mutations. Large remote metadata scans delay commands and file discovery.
6. Initial lookup is quiet in `useAudiobookExport`; the modal defaults an
   unresolved snapshot to Idle. Start/Build lack clear pending labels.
7. Export metadata reads collapse temporary read/HEAD failures into absence,
   potentially presenting a temporarily unreachable artifact as missing.
8. Assembly downloads source segments serially, publishes progress for each
   segment, and buffers the entire book. Conversion writes that buffer to disk
   and reads the entire output into memory again. Artifact SSE already carries
   assembling/transcoding/uploading phases, but the hook retains only a
   percentage. Transcoding and uploading can therefore remain at 100%.
9. Successful audiobook assembly operations already have
   `reusesSucceeded: false`; an old successful operation does not permanently
   prevent a replacement assembly job.

Production computer use observed the reported EPUB sidebar move from Idle /
Segments — / disabled Download to Ready / 2234/2234 / enabled Download. No
generation or cleanup was initiated during that inspection. The individual
production phases have not yet been timed; source findings explain plausible
mechanisms, not every second of the observed delay.

### Implementation plan

1. **Measure export phases.** Capture discovery, cached-source verification,
   synthesis settlement, assembly, FFmpeg, and upload timings with cache counts.
   Reproduce both a ready-file lookup and a missing-file rebuild using a large
   cached book. Do not log document text, credentials, tokens, or signed URLs.
2. **Make discovery and commands responsive.** Expose an initial checking state
   with skeletons/status and immediate Starting / Stopping / Building feedback.
   Resolve an existing usable file independently of the expensive chapter scan;
   apply conditional generation commands before collecting full progress.
   Preserve one server-classified snapshot, SSE ownership, and rejection of
   responses from replaced settings/documents/runs. Distinguish missing objects
   from retryable storage failures instead of silently showing Idle.
3. **Separate audio readiness from alignment completion.** Establish the durable
   audio-settled boundary after source verification and synthesis, guarded by
   generation identity, cache epoch, cancellation, and usage-limit state. Allow
   assembly at that boundary without waiting for optional word timing. Preserve
   alignment ownership and interactive highlighting; do not launch unowned
   background promises or infer completion from rounded percentages. Rebuild
   from already-settled cached sources without redundant synthesis. Show
   Checking cached audio during necessary verification.
4. **Make assembly bounded and visible.** Retain SSE phase in the UI and render
   Assembling MP3 / Encoding M4B / Uploading file. Use indeterminate progress
   where a meaningful percentage is unavailable. Introduce bounded ordered
   source prefetch, write assembly to a temporary file, let FFmpeg consume and
   produce files, and stream uploads. Coalesce intermediate progress while
   delivering phase changes and terminal events immediately. Clean temporary
   files on every exit and expose interruption/failure with an explicit retry.
   Keep generation Stop's scope honest; it must not pretend to cancel file
   assembly unless cancellation is implemented for that phase.
5. **Set an explicit audiobook retention policy.** Implement retention of
   finished MP3/M4B variants until explicit audio clearing, document/account
   deletion, or explicit storage removal. Separate audiobook retention from
   temporary account ZIP retention, remove
   the automatic audiobook sweep and obsolete callers/routes together, and
   verify cleanup and storage accounting for all variants. Preserve existing
   artifact IDs and readable metadata.
6. **Update active documentation.** Explain server-side artifact persistence,
   retention, and fresh download links separately from browser Cache Storage.
   Correct the Vercel guide's outdated playback-stream export description and
   update the normative architecture when implementation lands.

### Acceptance and validation

- Existing-export lookup immediately shows checking feedback and reliably
  exposes a ready download without waiting for chapter details.
- Start/Stop immediately show pending feedback; a slow chapter read does not
  prevent the command from being applied. Preserve conditional run ownership.
- A fully cached book can be rebuilt without new TTS synthesis or an alignment
  wait. Verification and file stages are visible; 100% segments never masquerades
  as a completed downloadable file.
- Exercise MP3 at 1x, speed-adjusted MP3, M4B, chapter output, skipped-segment
  retries, reload/reconnect, and worker interruption. Verify actual playable
  downloads and bounded assembly memory.
- Cover delayed progress reads, blocked alignment, missing final output with an
  old successful operation, temporary storage failure, and settings/run races.
- Inject production-like worker and object-storage latency rather than judging
  responsiveness from loopback calls. Verify prompt checking/pending feedback,
  lightweight discovery/commands, chapter detail loading, and storage retries.
- Validate the selected retention policy and existing deletion/accounting paths.
- Observe the journeys with computer use before adding small user-facing
  Playwright assertions. Run the complete checks listed below for this PR.

### Implementation result and local validation

- Fast export lookups and command acknowledgements omit the chapter scan; a
  separate details refresh fills chapter progress. Terminal SSE refreshes can
  preempt an older details read, with one client request owner and a coalesced
  trailing refresh. Chapter downloads cannot overwrite the main run snapshot.
- Document jobs verify cached sources in bounded batches and synthesize only
  missing audio. They do not enqueue word alignment; live playback continues
  to align and backfill cached audio. Checking, pending actions, chapter loading,
  assembly, encoding, upload, and retryable lookup errors are visible.
- Assembly keeps at most four source buffers, writes ordered temporary files,
  uses file-based FFmpeg, and uploads a readable stream with a known length.
  Each build owns an output key within the stable artifact directory, so a
  failed or invalidated upload cannot delete a successor's file. Source/run/epoch
  checks guard publication, and temporary files are removed on success/failure.
- Finished audiobooks are no longer automatically expired. Account ZIP retention
  remains seven days; explicit cleanup and storage accounting cover audiobook
  variants. The privacy notice and effective date reflect the retention change.
- The production storage error was fixed by deploying the matching worker;
  measurement now has loading, retry, and specific missing-endpoint/timeout errors.
- Local verification: 1,038 Vitest tests and all 43 Chromium/WebKit browser cases,
  including real playback, passed. The export journey holds worker responses
  pending to assert immediate feedback and verifies encoding/upload remain
  indeterminate. Additional tests cover 2,234 cached segments, blocked alignment,
  missing final output, temporary storage failure, invalidation during upload,
  ordered/bounded prefetch, streamed upload cleanup, and decodable speed-adjusted
  MP3/M4B output. A real reader M4B download decoded with all eight chapters.
- Production phase timings and a large-book production smoke test remain for
  deployment of this branch. Loopback observations are not a cloud latency
  benchmark. Structured lookup, source verification, assembly, encoding, and
  upload timings are available for those bounded before/after observations.

## Work 2: Normal playback startup performance

Branch: `codex/audiobook-export-reliability` (shared with Work 1).

### User-visible problem

Production time to first audio is slow even for cached audio, and grows as more
of the document is cached. This effort addresses interactive Play/resume/seek
startup; audiobook retention, controls, and file construction belong to Work 1.

### Investigation findings

- Before this branch, `useTtsPlayback` waited for foreground timeline readiness,
  then explicitly awaited another timeline refresh before assigning the audio source. In-flight
  reads may be shared, but an already-completed snapshot is not reused there.
- The worker audio route awaited `listCompletedDurations` before sending headers.
  `collectScopeSidecars` lists the entire settings scope and fetches uncached
  sidecars in sequential batches of 32. Warm reads still list the full scope.
- The sidecar cache is process-local, holds eight scopes, and previously retained completed
  sidecars only after alignment exists. Durably cached audio can therefore
  require repeated remote metadata reads.
- Interactive generation startup separately discovered all cached sidecars
  before synthesis. This improves sparse-cache behavior but still grows with
  cached segment count.

### Implementation plan

1. **Measure click-to-audible playback.** Separate preparation, activation,
   readiness metadata, audio response/first byte, and browser playing. Compare
   warm/cold metadata and small/large caches at beginning and deep cursors.
2. **Reuse startup readiness.** Remove the additional awaited whole-timeline
   refresh when the accepted readiness snapshot already supplies its state.
   Preserve run/session cancellation and stale-response protection.
3. **Prioritize a bounded startup window.** Read the selected ordinal and enough
   contiguous audio to start. Refresh the complete generated-cache overview
   separately through the existing SSE owner, preserving all cached chapters.
   Apply the same priority to interactive generation startup.
4. **Remove full-cache discovery from audio response preparation.** Preserve
   consistent Content-Length, range mapping, suffix starts, stream base time,
   deep seeks, highlighting, and same-session recovery. A compact rebuildable
   duration summary is a candidate only if range geometry requires it; do not
   assume a new schema or index. More concurrency or larger process caches alone
   do not satisfy the startup requirement.
5. **Validate smooth playback.** Keep contiguous startup buffering and enough
   refill runway for production latency. Preserve prompt pause/seek cancellation
   and bounded backpressure. Any buffer-target adjustment needs its own evidence.

### Acceptance and validation

- Adding cached chapters away from the cursor does not add remote metadata
  discovery to the critical path for first audio.
- Cached starts, resumes, deep starts, forward/backward seeks, reloads, and
  stalled-stream recovery preserve one canonical timeline and correct timing.
- Full generated ranges remain visible/reusable, and playback does not show
  Playing during silent preparation or buffer waits.
- Cover large/sparse caches, delayed metadata, startup cancellation, and stale
  responses. Observe actual playback/highlighting through browser controls.
- Run the complete checks below for this PR and compare bounded production
  timings after web and worker deployment.

### Implemented behavior

- Interactive generation goes straight to ordered per-segment cache checks;
  the whole-document verification scan remains owned by audiobook generation.
- The existing foreground SSE owner reads a bounded 64-ordinal cursor window
  for readiness and word timing. The full overview starts after the browser's
  `playing` event, then refreshes separately at a slower cadence. Neither the
  overview nor a duplicate timeline request gates Start or an accepted seek.
  A changed cursor supersedes a pending window read; stale results cannot
  overwrite the new run or delay the target's metadata behind an old request.
- One canonical grid merges completed audio and exact alignment from these
  reads. Its stream anchor is an ordinal, so loading earlier cached chapters
  rebases document coordinates without changing the audible media clock.
- Completed audio-only sidecars remain in the bounded scope cache. The full
  overview does not repeatedly download every unaligned audiobook sidecar;
  cursor-window reads refresh missing word timing as playback reaches it.
- Direct audio starts, including `fromOrdinal` suffix starts, need no duration
  catalogue before headers or the first byte. Nonzero byte ranges resolve only
  the needed prefix in batches of 32. The deterministic Content-Length,
  frame-valid silence, range semantics, and bounded stream remain intact.
- Browser startup logs separate preparation, activation, readiness, and media
  startup; worker logs capture layout and first-byte timings. These logs contain
  no document text, credentials, playback tokens, or signed URLs.
- No SQL migration, durable duration index, additional polling loop, or buffer
  target change was needed. Production before/after timings remain a deployment
  check; loopback timings are not a cloud performance claim.

### Combined local validation

- All 190 Vitest files / 1,053 tests passed, including blocked whole-book
  metadata, 10,000-ordinal direct/deep starts, exact byte-range prefix mapping,
  cursor supersession, stale responses, alignment backfill, and clock rebasing.
- All 43 Chromium/WebKit browser cases passed with the existing 50% worker cap.
  The consolidated real playback journeys now delay cursor metadata and hold
  the complete overview until audible playback and exact highlighting advance.
  Existing pause, section changes, cache reuse, and every accepted file type
  remain covered. Audiobook and storage journeys pass in the same matrix.
- Application/worker type checks, the production build, server bundle guard,
  route-error lint, and compute boundary checks passed. Port 3003 was freed
  after testing; the owner's TTS server was not restarted or stopped.
- Real browser controls reproduced cached playback and a later-segment seek
  on a disposable local stack. Worker logs showed zero duration catalogue reads
  before a direct suffix response. Quantitative production comparisons remain
  pending deployment of this branch; no cloud improvement percentage is claimed.

## Shared mechanisms and ownership

- Object storage, segment sidecars, cache epochs, session identity, SSE, and
  source verification are shared mechanisms. Export file lifecycle and browser
  media lifecycle remain separate owners.
- Shared changes include regression coverage for both consumers. Keep each
  change tied to a concrete requirement instead of pre-building abstractions
  for hypothetical future use.
- Both work areas ship together on this branch, while preserving separate
  acceptance gates and lifecycle owners.
- Keep Next as the authenticated control plane and the worker as the data plane.
  Preserve released data and current cache identities. Demonstrate and discuss
  any necessary schema addition before implementation. No new library,
  environment variable, or architectural layer is assumed by either plan.

## Completion checks for the combined implementation PR

Run the full Vitest suite, complete Chromium/WebKit Playwright matrix with the
existing 50% worker cap, application and worker type checks, production build,
route-error lint, and compute-boundary checks. New browser coverage follows real
computer-use observation. Do not restore Firefox without the owner's agreement.

Check port 3003 before starting a stack; Playwright owns its own stack. Never
run manual and Playwright stacks together, stop only task-owned processes, and
confirm the port is free afterward. Validate production latency with bounded
before/after observations when the relevant web and worker changes are deployed.
Commits, deployment, migrations, version bumps, and releases follow the owner's
explicit instructions; rewriting this plan authorizes none of those operations.
