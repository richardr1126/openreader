# Playback readiness, control reliability, and production latency

Status: initial repairs implemented and locally validated, based on
`main` at `9c3628f3`. A production
walkthrough on 2026-10-18 UTC reproduced startup/seek interference. The exact
cause of the separately reported permanent cached-segment stall is still
unverified. Implementation and validation results will be recorded below.

## Outcome

Opening a readable document must reveal a usable timeline at the restored
sentence. Play, pause, scrub, sentence skip, and section navigation must remain
predictable when requests take seconds and responses arrive out of order.
Every wait must either make progress, be superseded/canceled, or reach a visible
retryable failure. Cached audio and the canonical playback identity survive.

This extends [the playback architecture](PLAYBACK_ARCHITECTURE.md),
[reader readiness](READER_READINESS_STATE_MACHINE.md), and the implemented
[startup performance work](AUDIO_STARTUP_AND_EXPORT_RELIABILITY_PLAN.md).
Preserve that work's bounded cursor reads, deferred full overview, ordinal
stream anchors, and audio-before-alignment behavior. This is a focused repair
of the existing owners, with deletion of replaced paths, rather than another
playback architecture rewrite.

## What the code establishes

These are source findings, not claims that each mechanism caused the reported
production incident.

| Finding | Evidence and implication |
| --- | --- |
| Initial timeline loading is outside the reader reveal gate. | `ReaderPayloadBase` contains the plan and saved position but no timeline. `ReaderShell` gates source acquisition, session adoption, and renderer readiness. `useTtsPlanController` subsequently requests the idle layout, waits for client voice resolution, and ignores rejection. A readable document can therefore expose `0:00 / 0:00` and remain there after failure. |
| Startup clears the visible timeline and later reapplies its original start. | `useTtsPlayback.playWorkerPlaybackStream` clears the layout/projection, captures `selectedOrdinal`, waits asynchronously, then selects `generationStartOrdinal`. Run identity guards replacement runs, but does not itself identify a newer seek within the same run. Reproduce whether a newer target is overwritten during activation/readiness. |
| Idle scrubbing uses active-session pending-seek machinery. | `usePlaybackSeek` can create a pending seek without a session or audio source. Its completion needs a session, and `togglePlay` has a separate pending-seek branch that attempts activation before verifying a session exists. Establish explicit idle-selection semantics and test the first Play after a scrub. |
| Media positioning can fail without failing the seek. | `applyReadyMediaPosition` returns early without an active source, catches positioning errors, and ignores `play()` rejection. The caller can still clear the pending seek. Cached seeks bypass the pending-seek deadline. Metadata readiness therefore does not prove that the browser accepted or completed the media transition. |
| Recovery does not bound every lack-of-progress condition. | `createPlaybackRecovery` bounds reconnect attempts only after `readyTarget()` returns a target. With missing/stale readiness, it can return indefinitely. Initial/pending seeks have 60-second deadlines, but these do not cover all later stalls or rejected metadata refreshes. |
| Same-session ordering needs specific verification. | `usePlaybackForegroundSync` serializes activity writes separately from coalesced cursor writes, and activity writes capture an ordinal before entering their queue. The audio route also seeds the worker cursor from a range request. `installPlaybackMediaEvents` guards a run, while source replacements can occur within that run. Delayed commands, source events, and old range requests need adversarial ordering tests. |
| Browser coverage accepts the readiness gap and omits the reported interaction sequences. | `verifyEpubPlayback` explicitly waits for duration after renderer reveal. It delays cursor metadata by 150 ms and gates the overview, but does not commit rapid scrubs or sentence skips during startup/refill, or verify a failed cached seek. Other document types mainly exercise start/cancel. |

The latest timeline change, `9c3628f3` / #175, is the first comparison point.
Also compare #163's startup improvements and #167's playback fixes before
changing previously solved behavior. Older production slowness must be measured
separately from a recent regression.

## Behavior contract

1. **Timeline readiness belongs to initial reader readiness.** Before the
   reader is revealed, the effective playback settings, matching whole-document
   timeline, and restored plan ordinal are adopted. Show estimated duration
   explicitly where audio does not exist. A genuinely empty plan or non-text
   EPUB surface remains an explicit usable state with playback unavailable.
   Readiness does not generate audio or wait for word alignment.
2. **New user intent wins immediately.** A committed seek identifies a plan
   ordinal and an offset within that segment. Later duration corrections change
   its displayed document time, not the selected sentence. Repeated skips use
   the latest accepted target, even before React renders again. A pause cancels
   autoplay; it preserves the selected target and generated cache.
3. **Idle selection is usable without a session.** Scrubbing before first Play
   updates selection, timeline, and reader location without generation or a
   pending media operation. First Play starts from that selection. Scrubbing
   an existing paused session preserves pause and prepares that same session
   for resume without starting unnecessary forward generation.
4. **Only accepted current media can drive projection.** During a source
   replacement or pending seek, events from the previous source cannot move
   selection, resume playback, or overwrite the target. Seeking is complete
   only when current media has accepted its position; active playback is
   playing only after the browser reports playing. Verify clock advancement
   and actual sound in browser walkthroughs.
5. **Ready audio and playable runway are distinct.** Ready bands mean stored
   segment audio exists. A target may still need adjacent contiguous audio or
   a network fetch. The control shows buffering accurately, retains the target,
   and always permits cancellation or a newer seek. Audio never waits for
   optional exact word timing.
6. **Every wait has an exit.** Missing metadata, an SSE outage, failed
   generation, a rejected seek, and a dead media connection have explicit
   outcomes and retry paths. Preserve the canonical session/cache and selected
   target across recoverable failures. A retry must not silently start at zero.

## Implementation sequence

### 1. Establish reproductions and a latency baseline

Use a production build locally and a bounded production walkthrough. Confirm
the deployed web and worker revisions first; they deploy separately. Use a
disposable document for generation and do not clear existing production audio.

Extend existing structured timing around one playback action, using document,
plan, session-instance, operation, local intent, and media-source identities as
needed. Record bootstrap/timeline readiness, prepare/activate acknowledgement,
queue wait, provider time, audio persistence, SSE delivery, cursor-window read,
audio headers/first byte, browser playing, and first media-clock advance. Use
durations within each process rather than subtracting unsynchronized clocks.
Record cancellation, supersession, failure, and missing progress too; existing
`tts.playback.startup` output occurs only after successful startup.

Do not record document text, credentials, playback tokens, or signed URLs.
Reuse existing logs and performance marks; no telemetry service is required.

Build test-only controllable gates at the relevant boundaries. Browser routing
can delay browser-facing control/timeline/audio requests; worker/provider and
object-storage tests must separately cover their own delays. A single browser
network throttle does not model internal cloud hops. Release deferred responses
in a chosen order and inject one-off failure, not just fixed sleeps.

Start with 0.5–2-second control/metadata delays and 5–15-second generation or
first-byte delays. These are stress profiles, not measured production claims.
Include an overview held until playback advances, a missing SSE update followed
by reconnect, a cached-object read failure, and a media connection that stops.

Deliverable: reproduction steps, a boundary-by-boundary trace for each reported
failure, and baseline timings for cached/uncached, warm/cold worker metadata,
beginning/deep positions, and small/large sparse caches. Record median and tail
timings with sample counts; do not present a handful of runs as reliable p95.

### 2. Make the initial timeline part of shared readiness

Extend the existing bootstrap-owned preparation/adoption contract to include
the timeline for the effective playback settings. The server resolves saved
preferences and book overrides already, but the client currently resolves a
missing provider-default voice. Resolve that mismatch explicitly before naming
the audio cache: the shared bootstrap must supply or validate the same effective
voice/model/settings used by the first session. A plan ID alone is insufficient
because plans can be shared across voices.

Keep one shared readiness result and the existing shell. Adopt the supplied
plan, layout, and initial selection together; renderer placement can then commit
the final EPUB ordinal before reveal. Timeline failure reaches the shared error
and explicit Retry UI. A failed cache lookup must not pretend there is no cached
audio. Missing audio is normal and yields estimates; an unavailable read is an
error. Remove the detached idle-layout effect, silent catch, and duplicate
request once their responsibility moves into shared preparation.

Measure the cost of initial cache discovery on a large book. Avoid rereading
the plan or cache catalogue unnecessarily, and retain bounded worker I/O. During
later Play/seek, keep the adopted layout visible and merge current-session
updates into it; full cache discovery must remain off the first-audio path.
Replanning keeps the reader mounted, disables stale playback, and adopts the
new matching layout without returning to an unrelated document position.

Acceptance: the first visible readable surface already has a nonzero duration
and the correct selected sentence; reload needs no Play to populate either.
An estimated layout is labeled. Explicitly empty/non-text states do not hang.
No playback session or synthesis is created just to display the timeline.

### 3. Make startup and seeks respect one current target

Keep control ownership in `useTtsPlayback` / `usePlaybackSeek` and cursor writes
in `usePlaybackForegroundSync`. Use one current target, with a local revision
that advances synchronously for a new seek or cancellation. Preserve run and
session-instance guards for their existing broader lifetimes. Reuse existing
state where possible; do not add a second cursor store or processing flag.

Startup may prepare a session asynchronously, but activation and buffer/media
attachment must reconcile with the latest target. A superseded completion
cannot restore its captured ordinal. Pending readiness must follow that target,
not an obsolete `generationStartOrdinal`. Ignore old media projection while the
new target is pending. Retain intra-segment offset for exact cached seeks; an
estimated ungenerated target resolves to its segment start.

Separate idle selection from pending active-media work. Unify scrubber, sentence
skip, text tap, chapter/search navigation, keyboard, and OS media controls at
the existing ordinal-based seek boundary. Remove restart/teardown fallbacks
that create a new run merely because a layout or source is temporarily absent.

Reconcile activity and cursor writes through the existing foreground owner so
an older queued activity acknowledgement cannot restore an old ordinal after a
new seek. Test the worker's range-start cursor re-anchor against a superseded
stream. First use existing cancellation and instance ownership. If traces prove
that those cannot prevent a late server-side write, document the smallest
necessary protocol ordering change before implementation; a local revision
alone cannot order requests already executing on the worker.

Acceptance: hold A pending, commit B then C, release A and B last. Only C can
attach media, navigate, project, or direct continued generation. Pause during
any stage wins over late startup/seek/recovery. The canonical session/cache is
retained, and superseded generation stops at the existing cancellation boundary.

### 4. Complete seeks on browser success and bound stalled states

Make media positioning return an explicit accepted, superseded, or failed
outcome. Do not clear pending work after an early return or caught exception.
Scope source events and async `play()` completion to the accepted current
source/target as well as the run. Audit projection during `load()`, metadata,
seeked, timeupdate, pause, and playing transitions in Chromium and WebKit.

Keep same-session stream rebasing and document/media time conversion in their
current owner. When exact durations arrive, preserve ordinal plus offset and
recompute the displayed time; do not remap intent from stale absolute seconds.
Use the existing SSE-refreshed layout for readiness and coalesce its reads.

Define a progress deadline for each wait, using current request/seek limits as
the starting point: metadata requests currently use 30 seconds, and initial
buffer/pending seek uses 60 seconds. Bound cached-media recovery with the
existing two reconnect attempts and five-second stall detection. Tests must
cover those deadlines, including the case where no ready recovery target ever
appears. Do not resolve the report by increasing timeout values.

Progress means current-target audio/readiness or actual media advancement;
heartbeat traffic, an unrelated alignment update, a reload, and a corrected
document-time base must not masquerade as progress. Prefer the raw media clock
within one accepted source for stall detection. Terminal worker failures and
usage limits should resolve immediately rather than waiting out a deadline.
Reconnect existing SSE and perform a bounded resync through its owner when
needed; do not add a parallel seek/status polling loop.

On exhaustion, stop unneeded generation, settle controls into a retryable
failure, and keep selection and cached ranges visible. Retry resumes from the
current target in the canonical session when valid. Session expiry is handled
explicitly and must not be mistaken for a user seek requiring a replacement.
Visible status, accessible announcements, and OS playback state must distinguish
buffering from playing; the current player's live announcement uses playback
intent and needs correction as part of this work.

Acceptance: a cached forward/backward seek advances the current media clock
after delivery resumes, or visibly fails within its bounded recovery budget.
Ungenerated waits and lost read models cannot spin indefinitely. Retry and
Cancel work without a page reload or cache reset.

### 5. Remove measured production bottlenecks and verify the result

Use the baseline to choose optimizations. Separate client-to-Vercel control,
Vercel-to-worker acknowledgement, NATS queueing, provider generation,
object-storage readiness, SSE propagation, and browser media delivery. Compare
large cache/startup growth and refill behavior under sustained latency.

The client uses 10 seconds of startup runway and 20 for recovery, adjusted for
playback rate. Worker generation currently uses a 48-ordinal ahead window;
the shared 45-second refill and 60-second ahead constants do not define that
worker ceiling. The long-book walkthrough reached more than ten minutes ahead,
so do not describe its policy as a 60-second limit. Preserve these policies until
measurements justify changing them. Increasing buffers can worsen startup;
reducing them can expose more stalls. If changed, test first-audio latency and
continuous playback together, including faster playback and slow providers.

Deliverable: before/after timings by boundary and cache condition, with the
remaining dominant delay identified. Cached audio should incur no provider
generation or alignment wait; unrelated cached chapters must not extend the
Play/seek critical path. Any infrastructure recommendation follows measured
evidence about region, cold starts, storage, or provider capacity.

## Required regression matrix

Use deferred promises and fake clocks for exhaustive order/deadline tests, plus
real browser controls for media behavior. Observe each new browser journey with
computer use before writing its smallest useful Playwright assertions.

| Scenario | Required result |
| --- | --- |
| Open/reload at a saved nonzero sentence with delayed/failed initial layout | Timeline and position exist at first reveal, or shared Retry is shown; Play is unnecessary. |
| Scrub before first Play, with cached and uncached targets | Selection moves immediately; no generation starts; first Play uses that target. |
| Play, then scrub repeatedly while prepare/activate/readiness is held | Last target wins after old responses are released in reverse order. |
| Skip forward/backward into ready audio during refill or another seek | Current target plays; ready ranges remain; no new canonical session. |
| Several rapid next/previous presses before a render | Each press advances from the latest target; none is lost to a stale index. |
| Seek to an uncached target, seek elsewhere, then pause | Old readiness cannot move the cursor or restart audio; obsolete generation stops. |
| Pause, move cursor, then resume; repeat during loading | New target is retained with pause intent until resume. |
| Browser rejects positioning/play, holds play pending, or serves failed/stalled audio | Current operation recovers within bounds or exposes Retry; no false success. |
| SSE disconnect, failed timeline refresh, terminal worker failure, or usage limit | Bounded resync/failure, useful status, cancellation, and preserved target. |
| Earlier exact durations/late overview arrive while scrubbing or playing | Same ordinal/offset and audible word; corrected time and all known cache bands. |
| Old source events/range requests arrive after new seek or pause | No stale navigation, projection, autoplay, cursor restoration, or renewed generation. |
| Section change, replan, document switch, unmount, and session expiry during pending work | Only the current owner can publish; replacement settings use the right cache scope. |

Cover shared control behavior across EPUB, PDF, and HTML (TXT/Markdown), with
DOCX through its converted PDF path. Keep one consolidated real playback journey
per enabled browser; add focused component/worker tests for permutations rather
than multiplying costly TTS journeys. Extend ordinary reader tests for initial
timeline readiness. Retain real sound/highlight, natural segment-boundary
continuity, pause cancellation, and durable cache reuse checks.

For released implementation, run the full Vitest suite and complete Playwright
matrix, application and worker TypeScript checks, production build, server
bundle guard, route-error lint, compute-boundary and install-profile checks.
If worker protocol changes, regenerate and check OpenAPI/types. Preserve the
50% Playwright worker cap, Chromium/WebKit, and disabled Firefox policy.
Check port 3003 before starting; never overlap manual and Playwright stacks.
Stop only task-owned services and confirm the port is free afterward.

## Delivery and completion

Implement in dependency order: reproduce/measure, readiness, target ordering,
media completion/recovery, then evidence-led performance work. Each slice must
retain its regression cases. Update the normative readiness/playback documents
as behavior changes and remove superseded implementations and tests together.

Local success is insufficient to close the production report. After the owner
deploys matching web and worker revisions, repeat a bounded production sequence:
open at a saved location, cached Play, rapid seek/skip while loading, uncached
seek, pause/resume, section change, and reload. Verify audible progress, current
highlight/location, retained cache, and correlated timings. Include the slower
network/device class on which the issue was observed when available.

Complete only when all reported interactions work under injected delays and
production verification, stale work cannot take ownership, every stalled state
has a tested exit, and measured latency results are recorded. This plan adds no
SQL migration, cache-identity change, new library, or environment variable.
Implementation, commits, deployment, and releases remain separate actions.

## Production walkthrough — 2026-10-18 UTC

- Fresh anonymous session on `openreader.richardr.dev`, with privacy notice
  acknowledged and optional analytics declined. Imported Gutenberg #1342,
  *Pride and Prejudice*, through Add Documents → Project Gutenberg. The EPUB
  is 23.69 MB and its estimated audio duration is about 15 hours 49 minutes.
- Railway's active worker deployment was running its current `main` image.
  Used bounded log snapshots. Raspberry Pi KittenTTS inspection used only
  Kubernetes get/logs/top with its explicit kubeconfig; no cluster changes.
- Before Play, the reader showed `0:00 / ~15:48:37`. Pressing Play immediately
  changed this to `0:00 / 0:00`, then restored the estimated duration during
  preparation. The accessible live status said Playing during silent loading.
- At roughly 23 seconds after Play, dragged the scrubber from the start to
  `1:27:52`. At roughly 34 seconds, pressed Skip forward twice while loading;
  the selected time became `1:28:12`. The loading control remained cancelable.
- Worker logs show the canonical session first activated at ordinal 0, then a
  continuation at ordinal 495. KittenTTS completed synthesis during the wait.
  The browser nevertheless failed startup with "did not buffer enough
  contiguous audio in time" at 00:22:27 UTC, retaining the later selected time.
  At the 71-second observation, controls had returned to Paused.
- Retried Play from that position without further interference. Playback
  reached Playing and time advanced; at the 15.6-second observation it showed
  `1:28:28` and `75s ahead`. This is an upper-bound observation, not a precise
  click-to-first-audio measurement. The current console API flattens structured
  startup fields to Object, so those phase durations were not recoverable.
- A single forward skip into generated audio and a rapid forward/backward/
  forward sequence both recovered in this walkthrough. The first new suffix
  request reported 2,451 ms to first byte; time advanced again within the next
  12.2-second observation. Do not claim the permanent cached-skip failure has
  been reproduced from these successful checks.
- Paused the task-owned playback and reloaded. The saved nonzero sentence,
  estimated duration, and cache were restored without pressing Play. The
  precise first-reveal timing still needs an automated delayed-read assertion.
- Provider snapshots show completed synthesis, including 142,000 samples in
  about 2.5 seconds and 706,200 samples in about 10.8 seconds at 24 kHz. Provider
  generation contributes real latency, but completed requests do not explain
  the browser's obsolete startup buffer wait. Two provider pods were ready;
  no deployment-level warning events were returned. No provider configuration
  or deployment was changed.

First confirmed repair target: startup must wait for and attach the newest
accepted target, not continue waiting for the original generation start after
the cursor has already redirected generation elsewhere. Preserve the timeline
through that transition. Add deterministic delayed-start/retarget regressions
before accepting this fix.

## Implementation and local walkthrough — 2026-10-18

- Bootstrap now returns the effective playback request and its cached/estimated
  timeline with the plan. The shell adopts these together before reveal. The
  detached idle-layout request and duplicate client request construction are
  removed. No cache identity or stored-data migration changes.
- Startup retains the timeline and waits on the latest ordinal/offset. Idle
  scrubbing selects without generation. Active and startup retargets share
  cancelable, event-driven browser positioning; completion requires accepted
  media time and playable data. Clock/end events cannot overwrite a pending
  target. Sentence skips read the latest selected ordinal synchronously.
- Activity and cursor writes share a queue and resolve the current target at
  dispatch. Recovery now bounds a wait with no ready target as well as bounded
  reconnect attempts. Loading announcements follow media phase.
- Used a disposable local production-build stack and the same long EPUB.
  Initial reveal and reload both showed duration and saved position without
  Play. Scrubbing before Play, retargeting during loading, cached forward skip,
  cancel/resume, and reload retained the selected target and generated ranges.
  No browser console errors were observed.
- An immediate startup sequence (Play, scrub, forward twice within about
  1.6 seconds) reached Playing at the latest target. The structured startup
  measurement was 15,545 ms: prepare 13 ms, activate 13 ms, readiness 14,358 ms,
  media 1,161 ms. This is one local Supertonic sample, not a before/after
  comparison with production KittenTTS or a latency percentile.
- Screenshots and bounded diagnosis logs are under
  `/private/tmp/openreader-playback-investigation/`. Both task-owned browser
  playbacks were paused and the manual local stack was stopped before E2E.
- Worker generation remains unchanged. The large ahead duration and possible
  extra work from range-request cursor seeding need separate measured follow-up;
  neither is established as the cause of the reported permanent cached skip.

These changes shipped in PR #177. The production walkthrough below found a
second deadline interaction, so deployment alone did not close the report.

Validation: all 1,234 Vitest tests and all 49 local Playwright cases passed,
including the Chromium/WebKit real playback journeys. The latter hold a
prepared response while the user scrubs/skips, verify activation and the first
media suffix use the same newer ordinal, observe advancing audio, and verify
canonical-session reuse. App and worker TypeScript, production build, server
bundle guard, route-error lint, compute boundary, install-profile boundary, and
diff whitespace checks passed. The initial browser launch required macOS
sandbox permission; the first executing run exposed a title-page test
precondition after the new deep seek, which was restored through the user-facing
scrubber before the complete successful rerun. No matrix configuration changed.

### PR review follow-up

CI exposed an unconfigured-install regression: voice resolution required a
provider credential even for ordinary reading. Bootstrap now skips credential
resolution for static catalogues and for installations with no enabled shared
provider. It still returns the full estimated timeline before reader reveal;
generation retains its existing provider authorization requirements.

The review also identified recovery exhaustion clearing media handlers while
leaving the local session active. Exhaustion now resets the local playback
session while preserving position, so Retry prepares the same canonical identity
and installs fresh media handlers. A mounted controller test uses the real
audio/projection/seek owners to verify failure, preserved position, fresh startup,
reinstalled playing events, and an advancing clock. Provider-free and static
catalogue preparation have dedicated regressions.

### Production rollout and startup deadline follow-up

PR #177 merged as `b7ec1509576bf9b93d44bd2d37c4a9936270afc5` after 1,237
Vitest tests, all 49 local Chromium/WebKit cases, and CI/review passed. Docker
workflow `39159403330` published `main`; Vercel deployed that commit and Railway
redeployed its `main` worker image successfully (deployment
`cf079306-7fcc-4aea-ba39-d3e00a7a13e5`). No worker code or database schema changed.

The production anonymous Gutenberg EPUB retained its duration, cached bands,
and saved cursor before Play and after reload. Cached playback, rapid
forward/forward/back skips, and cancel/resume advanced the clock using the same
canonical session. Cached starts still took 12.4 and 20.7 seconds; these samples
do not establish a latency improvement or percentile.

A fresh uncached retarget exposed another failure. Play at 23:59:56 UTC on
2026-10-18, followed by a scrub and two forward skips, selected ordinal 1173.
Worker activation began at 00:00:09 UTC on 2026-10-19. The target persisted at
00:00:57.335, just after the pending seek's 60-second timer expired, while
startup's own readiness budget remained valid. The UI paused prematurely;
retry after caching played the same ordinal. Worker and read-only Raspberry Pi
KittenTTS logs showed successful generation, including a 27.3-second target
provider request, rather than a failed generation job.

Startup now owns its preparation, readiness, and initial media wait. Pending
seek expiry applies only after a media owner is active. Its existing 60-second
bound remains; startup retains its own readiness deadline and cancelable media
positioning. Session preparation now has a 30-second request deadline. Native
`TimeoutError` must reach failure cleanup even though its message contains
"aborted"; it must not be swallowed as user cancellation.

A mounted regression delays preparation 25 seconds, retargets, and supplies
ready audio 45 seconds after activation. It fails against the previous timer
and advances playback with the fix, using one canonical session. Additional
coverage preserves active-seek expiry, bounds missing startup readiness, and
checks timeout cleanup/retry and both preparation abort sources. Repeat
production verification is still required after this follow-up deploys.

### Progress-aware readiness follow-up

PR #178 merged as `ef5dc3f0d6a02b62f2f65d51ffa319575fc2012a` after all checks,
1,243 Vitest tests, and 49 local browser cases passed. Docker publishing
`39180548738` succeeded after retrying a Google Fonts loader failure. Vercel
production and Railway deployment `5146174d-8287-4632-a093-b731702280b5` succeeded.
The production uncached startup retarget reached Playing in 30.2 seconds;
rapid cached forward/forward/back skips recovered, and cached startup after
worker redeployment took 9.0 seconds. All used the same canonical session.

The final cancel/retry check found a related active-seek boundary. Play at
00:36:02.980 UTC on October 19 selected ordinal 2075. Its target persisted at
00:37:00.900, 57.920 seconds later, after several nearby ordinals had become
ready. The fixed 60-second seek deadline expired before the target's ready SSE
snapshot arrived. The UI paused instead of hanging, but unnecessarily failed
playback despite ongoing generation progress. Worker and provider logs showed
successful generation rather than a service error.

Startup and active seeks now share one readiness deadline policy. Only newly
cached ordinals inside the selected cursor's existing 64-slot read window count
as progress. The wait fails after 60 seconds without that progress, with a hard
120-second cap per target; repeated snapshots and unrelated windows cannot
extend it. Once the target's runway is ready, browser positioning owns its
existing 30-second deadline. No additional network polling or remote state was
added. A user retarget creates a fresh bounded wait and supersedes the old one.

Regressions cover readiness arriving after the original wall-time deadline,
duplicate/unrelated snapshots, the hard cap, unchanged no-progress expiry, and
late cached readiness handing ownership to media positioning. Full validation
and another deployment/production pass remain required before closing this
report.
