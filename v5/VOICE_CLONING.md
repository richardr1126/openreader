# Personal cloud voices

Reader parity item 11 was accepted retroactively on 2026-10-26: personal voice
cloning belongs on both web and Swift, including provider-backed cloning.
Web has no purchase gate. Swift reuses the existing voice-cloning Pro gate.
Neither platform promises free provider usage or falls back to a paid model.

The shared voice picker offers Your voices and the same dashed Create your own
voice / Add another voice card above Built-in voices for Fish Audio and
OpenRouter. Web/desktop follows Swift's existing personal-voice workflow using
OpenReader's compact web voice rows and standard dialog controls. Both
support recording/import, reviewing a selected 1–15.9 second clip, naming,
an exact transcript (required for Fish), permission confirmation, selection, previews,
rename and removal. Only endpoints advertising `supports_voice_cloning` enable
OpenRouter creation, with variant suffixes preserved in discovery and synthesis.

The editor uses the same capture, recording and review steps on every platform:
one heading and introduction, recording tips recommending 10–15 seconds, Record
and Import tiles, the shared read-aloud passage, sample playback and trimming,
Name, the transcript (required for Fish, whose reference schema requires it, and
collapsed and optional for OpenRouter), permission and a persistent Save action.
A recording prefills the transcript with the passage; an import leaves it empty. Row options offer Rename and a separate confirmed Delete.
Platform presentation follows each app's existing controls. Provider/privacy
disclosures, actual model input limits and the native Pro gate also differ.
Nano still requires at least ten seconds; other engines accept
shorter references. Deleting a selected voice removes its row immediately and
selects a preset without waiting for a catalog refresh or another selection.
Swift also replaces the affected saved global/current-book choice immediately,
so Done cannot restore the deleted clone. Clone IDs never become preset entries.
The parity follow-up passed the full web unit and 75-case Chromium/WebKit
matrix, native tests and simulator/Catalyst builds. Visible checks covered web
capture/import/review and management, plus deleting a saved selected iOS clone
and reopening the picker. Browser regression cases also cover deletion when
the catalog refresh cannot reach the server.

The web settings picker uses its resolved displayed model for capability checks,
voice catalogs, favorites, previews and saving. An empty or stale saved model
must not show Fish's free preset while checking a different raw model ID.

## Storage and execution

Web stores one private immutable-reference JSON object per voice under
`cloned_voices_v1/users/<encoded authenticated user ID>/<UUID>.json` in existing
object storage. The authenticated CRUD API never accepts a caller's user ID;
list responses contain metadata only. It bounds incoming bodies, WAV format,
duration, transcript, name, provider response and library size. No SQL migration
or new secret is needed. User-storage cleanup removes the private objects.

Both providers clone from private reference samples during synthesis. Fish uses
`references` with binary WAV bytes in its documented MessagePack speech request;
OpenRouter uses inline `input_references`, omitting a preset `voice`. The worker
loads the private WAV only at execution. Audio bytes never
enter preferences, queued jobs, SSE, or logs. Provider keys retain their existing
encrypted app storage/broker boundaries. The app's bounded creation route only
registers private samples. It does not create models in the provider account.

Each selected clone has an immutable `clone:<UUID>` identity bound to provider
configuration and model. Renaming does not regenerate narration. Reference audio
also participates in the process-local synthesis cache by digest. Previews and
narration share resolution, normalization, cancellation and existing export paths.
Removing a saved voice leaves generated narration and timeline cache intact.
Reference resolution is lazy: cache hits never require the saved reference.
Guest-to-account claims transfer private voice objects before preferences move.
Removing a saved choice deletes its private sample. No upstream model is created
or left behind. Custom provider voice IDs keep their existing execution path.

Swift keeps voice manifests and reference clips in its private app container,
separate from synced preference bytes. The selected ID can sync; the sample
does not. Another device reports a missing sample instead of substituting a
different voice. Keychain and per-device provider consent still authorize all
uploads and speech requests. Cancellation and bounded transport remain shared.

## Provider contracts

- [Fish reference-audio speech API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
- [Official Fish MessagePack transport](https://github.com/fishaudio/fish-audio-python/blob/main/src/fishaudio/resources/tts.py)
- [OpenRouter voice cloning](https://openrouter.ai/docs/guides/overview/multimodal/tts#voice-cloning)

## Validation checkpoint

2026-10-26: all 1,537 Vitest tests pass, including encrypted private sample creation,
ownership, malformed/oversized references, missing-reference cache reuse,
OpenRouter variant IDs, inline audio and transcript requests, preset omission,
and distinct reference cache identities. The production build, app/worker type
checks and route/compute/install-profile boundary checks pass.
Voice samples use the same S3 AES256 policy as other private artifacts. The
web, desktop and iOS privacy disclosures now describe optional reference-audio
transmission, and the web policy timestamp is updated for that material change.

All 75 Chromium/WebKit cases pass. The matrix covers both native Fish and OpenRouter import,
trim review, permission-gated save,
selected-voice persistence, reload, rename and removal. Both existing consolidated
real-playback journeys remain part of the complete matrix. Visible web checks
also exercised those controls against the local production stack. Native visible
checks opened Fish's cloning entry and the reused recording/import editor.
Simulator and Catalyst builds and the complete native suite pass, including
binary Fish reference requests, OpenRouter reference/capability requests,
permission rejection, rename/removal and presentation-name cache independence.

A complete browser run exposed a delayed bootstrap response overwriting newer
appearance settings. The existing bootstrap owner now preserves presentation
saves acknowledged after a request began and bases subsequent appearance writes
on the latest acknowledged settings. Deferred HTTP and SSE regression tests cover
the ordering, without adding polling or changing timeline identity. One native
system-speech timing assertion failed during a full run and passed on the full
rerun with the app closed.

Authenticated checks with an 8.44-second synthetic reference pass for both
providers on `s2.1-pro-free` / `fish-audio/s2.1-pro-free:free`: web creation and
worker preview, canonical document narration with zero skipped segments, cached
MP3 audiobook export, and native creation/synthesis/AAC normalization. All six
preview/native/export audio outputs decode successfully and contain non-silent
speech. Native live tests are opt-in with `TEST_RUNNER_OPENREADER_LIVE_CLONING_DIRECTORY`
pointing to a private temporary directory containing `credentials.json` (fields
`fish` and `openrouter`) and `reference-speech.wav`; no keys enter test-runner
configuration or source files. Default test runs skip these billed-service checks.

The live check found that Fish's saved-model API rejects a valid free-tier account
with a 0/0 model-creation allowance and a request to top up API credit. Its
documented stateless reference path succeeds on the same free model and key,
including with an omitted transcript. Both platforms now use that path directly,
without an implicit paid fallback or a second provider-side voice library.

Real-speaker microphone capture and formal voice-similarity evaluation remain
unverified. Temporary live credentials and provider entries are removed after
verification; no secrets are included in reports or fixtures.
No release, migration, commit or deployment was performed for this increment.
