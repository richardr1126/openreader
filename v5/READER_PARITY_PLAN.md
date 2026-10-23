# Reader parity implementation plan

Updated 2026-10-23. This is the shared implementation order for the web and
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
| 4 | Manual browsing and follow controls | Review cursor/playback separation first; implement reader controls and navigation against that contract. Preserve canonical playback identity and existing readiness events. |
| 5 | Citation and bracket handling | Define source-to-spoken mapping and cache implications before preference UI. Text transformations must not invalidate word highlighting or stored progress silently. |
| 6 | Added web pauses | Establish the actual pause contract before implementation. Swift's existing controls refer to generated-piece and reader-block boundaries; these are not guaranteed sentence and paragraph boundaries. No Swift pause redesign is currently requested. |
| 7 | Optional external providers on Swift | Keep on-device reading the default. Establish secure configuration, credentials, and execution contracts first; implement adapters and UI afterward using existing web provider capabilities. |
| 8 | FishAudio | The only requested new provider. Implement both platforms after the provider contract exists; review credential handling and execution boundaries. |
| 9 | Optional queued voice changes | Preserve current Apply. Add a distinct queue option after specifying its interaction with generated audio, timeline reuse, and current playback. |

## Explicitly deferred or excluded

- Swift DOCX and PPDocLayout/PDF classification work.
- Additional web ONNX TTS models beyond the current Kokoro, or new providers
  other than FishAudio.
- Web offline/chapter downloads and new cache-retention workflows. Swift already
  uses purgeable audio cache; no new retention feature is requested.
- Export redesign, additional export formats, and new background export jobs.
- Lookup/translation and annotations; existing bookmarks remain the reader UX.
- Player layout changes, remappable shortcuts, and a custom Live Activity.
- Cross-product self-hosted synchronization, Zotero integration, and WebDAV.

## Current checkpoint

The completed baseline is committed on the paired integration branches. Items
1–3 are now implemented there. The owner approved global/per-book typography
and highlight appearance with iCloud sync, including their optional SwiftData
fields and additive CloudKit fields. Web uses existing preference/document JSON
without a SQL migration. Appearance saves update the existing ready reader
snapshot and never re-bootstrap audio. Speech-only saves preserve current
presentation settings. The web controls reuse the existing grouped setting
rows, selectors and color picker, without an enclosing card around the groups.
Per-field inheritance resets are small inline icons beside controls on both
platforms; section resets live in the headers. Showing an override must not
add a row or increase the control/section height.
Batch validation: 1,425 Vitest tests and all 55 Chromium/WebKit Playwright
cases pass, including both consolidated playback journeys. The production
build and route/compute/install-profile boundary checks pass. Native build
and all 392 package tests pass. Visible checks covered shared picker favorites,
global preference reload, book font inheritance/reset, native preset previews,
flowing-text font changes and EPUB reflow at 125% with the cursor unchanged.
Two-device iCloud delivery and Production schema deployment remain unverified.

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
