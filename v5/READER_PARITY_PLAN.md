# Reader parity implementation plan

Updated 2026-10-26. This is the shared implementation order for the web and
Swift repositories. Platform capability parity does not introduce cross-service
library or settings synchronization.

## Integration and ownership

- Continue directly on the existing `codex/reader-parity` branch in each
  repository. Do not create a branch/worktree for every feature. Main remains
  unchanged until the owner requests integration there.
- One feature implementer owns both platforms, its focused tests, and its
  documentation. Complete one feature increment at a time, with one writer per
  repository. Independent read-only reviews can run in parallel. Checkpoint
  verified changes as cohesive commits on these existing branches.
- Integration review owns persistent identities, schema and sync decisions,
  reading-location mapping, audio timing and canonical cache behavior,
  credentials, and provider execution boundaries. UI and ordinary feature code
  stay with the feature implementer through verification and fixes.
- Checkpoints: agree on the feature contract; produce one buildable increment;
  review sensitive boundaries and exercise the affected flow; then integrate.
  New schema additions require approval. Do not use a new serialization scheme
  inside an unrelated preference merely to avoid this checkpoint.
- Only one shared web runtime or E2E stack uses port 3003. Serialize full native
  builds and simulator checks. Focused tests belong to each feature; full suites
  run at integration checkpoints, without redundant reruns of unchanged work.
- Commit locally in coherent parts. Publishing, merging to main, releases,
  production CloudKit changes, and database migrations remain separate actions.

## Completed baseline

- Independent segment and word highlighting on web EPUB, flowing text, and PDF.
  Turning off segment styling preserves the mapping needed for word-only mode.
- Swift global segment visibility and an optional per-book override, independent
  of the existing word-highlight preference. Visible controls say “segment.”
- Swift Now Playing artwork uses the existing book cover, bounds its retained
  image, and rejects stale results after switching books.
- Swift typography and voice-favorites persistence/sync foundation: global
  defaults, optional per-book typography overrides, reset/inheritance, stable
  favorite identities, and independent sync clocks. UI and rendering remain.

The baseline passed the full web unit and Chromium/WebKit suites, production
build and boundary checks, plus the Swift build and test suite. Real reader
controls were inspected on web and the iPhone simulator. Physical-device Dynamic
Island artwork remains unverified. The additive Swift segment preference fields
also require Development exercise and owner-coordinated Production CloudKit
schema deployment before distribution; see the Swift architecture document.

## Ordered backlog

| Order | Work | Implementation scope and review boundary |
| --- | --- | --- |
| 1 | Voice favorites | Implemented in both shared pickers: independent favorite buttons, filtering and persistence. Web uses synced user preferences; Swift uses the existing iCloud speech record. |
| 2 | Typography | Global/per-book controls and EPUB/flowing-text rendering implemented on both platforms. Preserve publisher defaults, Dynamic Type and playback identity. PDF page typography is unchanged. |
| 3 | Highlight appearance | Global/per-book segment and word colors, opacity, presets, inheritance/reset implemented. Swift adds the approved optional storage field and independent iCloud clock. Production schema deployment and two-device verification remain owner follow-ups. |
| 4 | Manual browsing and follow controls | Implemented on web and Swift: browsing preserves playback, Follow narration controls viewport movement, and Return to narration rejoins the live cursor. Explicit text/player/contents seeks enable following through the existing playback path. No schema or audio identity changes. |
| 5 | Citation and bracket handling | Implemented on web and Swift: numeric/author–year citation skipping and Off/Square brackets/Parentheses/Both prose handling, with independent app defaults and per-book overrides. Source maps preserve highlighting and progress; filtered audio uses separate reusable cache variants. See `SPEECH_TEXT_HANDLING.md`. Production CloudKit schema deployment and two-device delivery remain owner follow-ups. |
| 6 | Added web pauses | Implemented: Automatic preserves existing engine pauses (currently 0 ms added on web), with app defaults and independent book overrides. All providers support between-segment pauses; worker-local Kokoro also supports custom piece length and between-piece pauses. Boundaries are generated pieces and reader blocks, not necessarily sentences/paragraphs. See `VOICE_CUSTOMIZATION.md`. Swift is unchanged. |
| 7 | Optional external providers on Swift | Keep on-device reading the default. Establish secure configuration, credentials, and execution contracts first; implement adapters and UI afterward using existing web provider capabilities. |
| 8 | Fish Audio and OpenRouter | Native Fish Audio is implemented on web and Swift; see `FISH_AUDIO.md`. Add OpenRouter on both platforms with all discovered speech models, model-specific options, capability-aware Instructions, API voice catalogs and verified fallback voices. OpenRouter remains planned; see the contract below. |
| 9 | Optional queued voice changes | Preserve current Apply. Add a distinct queue option after specifying its interaction with generated audio, timeline reuse, and current playback. |
| 10 | Replace DeepInfra with Google AI Studio | Implemented, 2026-10-26: current web/desktop and Swift setup and execution use native Gemini 3.8 Flash/Flash-Lite TTS, 30 preset voices, custom voice IDs and Instructions. DeepInfra setup/key cleanup follows the Speech SDK removal; stored audio is untouched and old credentials are never relabeled. Archived release docs remain. See `GOOGLE_AI_STUDIO.md` for execution and validation. |
| 11 | Personal voice cloning on web and Swift | Added retroactively and implemented, 2026-10-26. Record/import, trim, name, consent, select, preview, rename and remove saved voices through native Fish Audio or cloning-capable OpenRouter speech endpoints. Free OpenReader feature on web; existing iOS Pro gate retained. Provider usage charges remain separate. Validation and live-provider limits are recorded in `VOICE_CLONING.md`. |

## Explicitly deferred or excluded

- Swift DOCX and PPDocLayout/PDF classification work.
- Additional web ONNX TTS models beyond the current Kokoro, or new providers
  other than Fish Audio, OpenRouter and the Google AI Studio replacement in item 10. Models accessed through OpenRouter are
  included in item 8; each underlying service does not need a native adapter.
- Web offline/chapter downloads and new cache-retention workflows. Swift already
  uses purgeable audio cache; no new retention feature is requested.
- Export redesign, additional export formats, and new background export jobs.
- Lookup/translation and annotations; existing bookmarks remain the reader UX.
- Player layout changes, remappable shortcuts, and a custom Live Activity.
- Cross-product self-hosted synchronization, Zotero integration, and WebDAV.

## Item 8 continuation: OpenRouter

Add OpenRouter to the existing web and Swift external-provider flows. Native
Fish Audio remains complete; this continuation adds a separate provider choice.
The scope is every speech model exposed by OpenRouter, including free variants,
rather than a fixed selection of familiar models. This is an implementation
backlog contract, not a claim that OpenRouter support has shipped.

### Discovery and model capabilities

- Discover models with
  `GET https://openrouter.ai/api/v1/models?output_modalities=speech` and synthesize
  through `POST https://openrouter.ai/api/v1/audio/speech`. Use returned model
  IDs verbatim, including variant suffixes. Refresh the catalog without silently
  changing saved selections, favorites or cached audio when entries disappear.
- Resolve capabilities by provider, model and relevant endpoint. Use API
  metadata where available and explicit, documented model rules where it is
  incomplete. One resolved capability contract must drive both visible controls
  and request validation on each platform. Unknown capability values must not
  masquerade as confirmed support or exclude an otherwise usable model.
- Expose the selected model's supported options, defaults, required values and
  limits through the existing settings controls. Cover voice selection,
  Instructions, synthesis speed and provider-specific options. Preserve the
  provider slug nesting under `provider.options`; validate documented fields
  and omit unsupported values. Changing models must not forward incompatible
  settings from the previous model. Investigate the option contract for every
  discovered family rather than assuming OpenAI-compatible syntax makes every
  option portable.
- Account for reference audio/images and multi-speaker inputs where supported
  or required; use endpoint capability flags and model-specific validation.
  Verify narration behavior for prompt-based models, including faithful reading
  and alignment, before marking their reader integration complete.

### Instructions and voices

- Show Instructions only for a provider/model confirmed to support it, across
  setup, previews and reader settings. Send OpenRouter directions through its
  top-level `instructions` field. Do not apply the native Fish bracket prefix
  as well. Keep native Fish's existing transformation and original source text
  for alignment. Hidden instructions must not be sent or alter audio identity.
- Populate the shared voice pickers from `supported_voices`. A null or empty
  list means the catalog supplies no presets; investigate the model instead
  of declaring it voiceless or borrowing another model's voices. Retain custom
  voice IDs where accepted. Offer Automatic only when voice omission is valid.
- For Fish models without a catalog, reuse the existing public reference IDs
  and names (Sarah, Energetic Male, Adrian, Delia and Sheila) after verifying
  compatibility through OpenRouter. Keep Sarah as the preferred named default
  where verified. Check each model, including S1, independently; its presence
  in OpenRouter is separate from its retirement in the native Fish adapter.
  If an upstream preset/default cannot be verified, expose the required custom
  voice/reference input with a clear explanation instead of inventing an ID.

### Research checkpoint — 2026-10-26

Read-only checks of the public catalog returned **36 speech models**, all with
`supported_parameters: []`. Neither that field nor the endpoint responses
checked provide an Instructions support flag. Endpoint responses do expose
reference-input capabilities. Discovery alone is therefore insufficient for
building the settings form. Recheck these observations during implementation.

| Missing voice catalog | Finding and implementation follow-up |
| --- | --- |
| `fish-audio/drama-3`, `fish-audio/s1`, `fish-audio/s2-pro`, `fish-audio/s2.1-pro-free:free`, `fish-audio/s2.1-pro` | All five return `supported_voices: null`; the endpoint responses checked supply no preset list either. Existing native Fish references are fallback candidates, not verified OpenRouter voices. Test named/custom references and voice omission per model. |
| `bytedance-seed/seed-audio-1-0` | Returns `supported_voices: null`. Its documented prompt mode permits voice omission. Plan an Automatic choice and investigate documented Seed speaker IDs before adding named defaults. |

The free Fish model's catalog `links.details` resolves to an endpoint list
without `:free` and returns no endpoints. Looking up
`/api/v1/models/fish-audio/s2.1-pro-free:free/endpoints` returns its free endpoint.
Preserve the selected variant when resolving capabilities; do not interpret the
unqualified link as proof the free model is unavailable or substitute a paid one.

OpenRouter documents Instructions for OpenAI GPT-4o mini TTS, Gemini TTS and
Fish Audio, with Fish prefixing performed by OpenRouter. Confirm exact model
coverage, especially S1, rather than inferring it from vendor names. Documented
format restrictions include PCM-only Gemini/HeyGen and MP3-only MiniMax.
Google options include `google-ai-studio.temperature` and `speech_metadata`;
HeyGen exposes `heygen.language`. These are investigation examples, not an
exhaustive option list. Seed's documented limits include 3,000 input characters,
0.5–2.0 speed and 120 seconds of generated audio.

Sources: [OpenRouter TTS guide](https://openrouter.ai/docs/guides/overview/multimodal/tts),
[live speech catalog](https://openrouter.ai/api/v1/models?output_modalities=speech),
[model endpoints API](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model),
and the existing native [Fish Audio contract](FISH_AUDIO.md).
No authenticated OpenRouter synthesis was performed for this checkpoint.

### Execution and acceptance

Use the existing credential and execution owners: app-owned encrypted keys and
worker credential broker on web; Keychain and direct bounded transport on Swift.
Keep credentials out of jobs, browser responses, events and artifacts. Preserve
canonical timelines, cancellation, alignment, reusable audio and export. Include
effective model, voice, Instructions and synthesis options in existing audio
identity so different output settings cannot reuse the wrong audio.

Handle each model's audio format, PCM framing/sample rate and input/output limits
through existing normalization and bounded generation. Omit unsupported synthesis
speed; retain the existing player speed behavior. No implicit paid-model fallback.
Use existing settings storage where suitable; any necessary schema addition
still requires approval before implementation.

Acceptance covers catalog refresh and variant IDs, voice/default/custom selection,
Instructions visibility and single application, model-option validation, preview,
save/reload, real narration, cancellation, cache reuse and export on both platforms.
Add request-contract coverage for every discovered family and explicit missing
metadata cases, plus authenticated samples for fallback voices before calling
them verified. Exercise visible controls and run the repository's complete web
and native validation at the implementation checkpoint.

## Current checkpoint

The completed baseline is committed on the paired integration branches. Items
1–6 are now implemented there. The owner approved global/per-book typography
and highlight appearance with iCloud sync, including their optional SwiftData
fields and additive CloudKit fields. Web uses existing preference/document JSON
without a SQL migration. Appearance saves update the existing ready reader
snapshot and never re-bootstrap audio. Speech-only saves preserve current
presentation settings. The web controls reuse the existing grouped setting
rows, selectors and color picker, without an enclosing card around the groups.
Per-field inheritance resets are small icons right after the row label on both
platforms, with no reserved space when absent; a highlight layer's reset clears
its color and opacity together. Section resets live in the headers. Showing an
override must not add a row or increase the control/section height.
Typography uses compact numeric controls, visual spacing/width choices and a
live reading sample. Spacing, reading-width, alignment and (web) highlight presets
all use the platform segmented control (web `SegmentedControl`, SwiftUI
segmented `Picker`); a custom value selects no segment. Web rows share one
right-aligned control column: segments/selects one width, steppers another. The reading sample grows with
the display (taller box, multi-paragraph passage, faded clip). Highlight settings lead with a live preview and four color
samples with selected states; each layer has one color and opacity control,
without duplicate intensity preset buttons. Native preset labels fit narrow
phone layouts. Web typography and highlight rows use the same leading row icons
and ⓘ help popovers as other settings, in both app settings and reader sidebars.
Explanations stay in the popovers; previews, aligned controls and reset actions
remain visible. Wide controls wrap below their labels when the sidebar is narrow.
Web Appearance uses the shared settings Discard/Save bar. Theme and custom
colors preview live on the page; typography and highlights preview in their
samples and save together in one request. Discard, or leaving unsaved, restores
the previous theme. Book appearance uses the same bar, including inheritance
resets. Failed saves retain drafts for retry. iOS continues saving immediately.
Batch validation: 1,425 Vitest tests and all 55 Chromium/WebKit Playwright
cases pass, including both consolidated playback journeys. The production
build and route/compute/install-profile boundary checks pass. Native build
and all 392 package tests pass. Visible checks covered shared picker favorites,
global preference reload, book font inheritance/reset, native preset previews,
flowing-text font changes and EPUB reflow at 125% with the cursor unchanged.
Two-device iCloud delivery and Production schema deployment remain unverified.

Item 4 keeps follow state local to the open reader. Page turns and scrolls do
not change the narration cursor, persisted progress, generation window or audio
identity. Turning following on, or choosing Return to narration, moves only the
view and works while paused. Text taps, player seeks, contents, search and
bookmarks remain explicit playback seeks and re-enable following. Playback
resume alone preserves manual browsing. Swift's reader toolbar exposes these
controls on iOS and Catalyst; text, spreads, PDF and EPUB share the contract.
Web exposes the controls beside the existing page/progress readout. No new
storage, synchronization fields or readiness requests were introduced.

Item 4 validation: all 1,427 Vitest tests and all 55 Chromium/WebKit cases pass,
including both consolidated playback journeys. The production build, app type
check and route/compute/install-profile checks pass. Native simulator and
Catalyst builds and all 392 package tests pass. Visible checks covered web PDF
browsing/return, native text browsing during active narration, paused return,
and native EPUB page turns/return with the saved ordinal unchanged. Native PDF
and spread rendering were build-checked but not separately exercised on screen
for this increment. Changes remain local on the existing paired branches.

Item 5 validation: all 1,438 Vitest tests and all 57 Chromium/WebKit cases pass,
including both consolidated playback journeys. The production build, app and
worker type checks, and boundary checks pass. Native simulator and Catalyst
builds and all 398 package tests pass. Visible checks covered web defaults,
reload, book overrides/reset and PDF block-kind placement, plus native defaults,
relaunch, independent book overrides and inheritance reset. One existing Apple
speech timing test failed during a run with the reader open; it passed on the
complete rerun with the app closed. Production CloudKit deployment and
two-device delivery remain unverified owner actions. Source and cache contracts
and approved storage additions are recorded in `SPEECH_TEXT_HANDLING.md`.

Item 6 validation: all 1,452 Vitest tests and all 59 Chromium/WebKit cases pass,
including the consolidated real-playback journeys with a 150 ms segment pause
and their original assertions unchanged. The production build, app and worker
type checks, and route/compute/install-profile checks pass. Visible checks
covered Automatic (0 ms), draft save/discard, reload, independent book
overrides/reset, local Kokoro splitting/pauses, actual playback and downloading
an audiobook assembled from the durable reading cache. The increment fixed a
JSON-settings decoding omission that made resumed timing estimates drop added
pauses; regression tests require object and stored-string settings to agree.
Voice customization uses the unchanged shared setting row, compact inline
selectors, and sliders confined to the control column for Custom values.
Browser assertions cover inline alignment and unclipped values at phone width.
Swift code and its existing pause defaults are unchanged. Changes remain local
on the existing integration branch.

The accepted favorite identity on web is the structured tuple of resolved
provider configuration reference, model ID, and voice ID. Serialize lookup keys
as JSON tuples so IDs containing separators cannot collide. Persist structured
entries in the existing user preference JSON, independently of Apply/Save.
On Swift, use the current voice-selection identity of source plus identifier;
locale and catalog revision changes must not remove a favorite. The first
increment uses UserDefaults, retains unavailable favorites, and changes neither
selection nor playback when a star is toggled. Favorites also sync through the
existing Swift speech-preference record, without changing the selected voice
or triggering audio work when only favorites change. Existing CloudKit
`modifiedAt` fields retain their original voice/theme meaning. Separate optional
journal clocks track typography and favorites uploads, so a later unrelated
clock cannot hide an offline edit.

Typography proposes seven settings: font family, size, line spacing, paragraph
spacing, letter spacing, reading width, and alignment. Untouched settings must
preserve current reader appearance and publisher styles; percentage controls
must not silently replace the existing baseline widths or Dynamic Type sizing.
Global settings use existing preference storage. The Swift per-book
storage is one optional `LibraryDocument.typographyOverrideData` field, with
absence inheriting global preferences. New CloudKit typography fields and a
favorites field require a separate Production deployment before distribution.
Two-device CloudKit delivery and physical-device Now Playing artwork remain
unverified; neither is established by simulator package tests.

### Shared control contract

| Setting | Default | Supported values |
| --- | --- | --- |
| Font family | Default/publisher | Default, serif, sans, rounded, mono; existing/system fonts only |
| Text size | 100% | 75–160%, step 5% |
| Line spacing | 1.5 | 1.1–2.2, step 0.1 |
| Paragraph spacing | 1 em | 0.25–2 em, step 0.25 |
| Letter spacing | 0 em | 0–0.12 em, step 0.01 |
| Reading width | 100% of current baseline | 40–100%, step 10%; preserve native Dynamic Type and existing widths |
| Alignment | Default/publisher | Default, left, justified |

Per-book fields inherit independently from global preferences and can be reset
individually. Untouched EPUB settings preserve publisher styles. Layout
measurement and rendered typography must agree so reflow retains the logical
location and active word/segment mappings.

Favorites belong in the existing shared voice picker on each platform:
`VoicePicker` on web (reader sidebar and provider settings) and `VoiceSetupView`
on Swift (onboarding, global settings, and book settings). Stars are independent
of row selection, preview, downloads, and Apply/Save. Filtering composes with
search/language availability and always provides a way to return to all voices.
