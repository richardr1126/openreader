# Reader parity implementation plan

Updated 2026-10-23. This is the shared implementation order for the web and
Swift repositories. Platform capability parity does not introduce cross-service
library or settings synchronization.

## Integration and ownership

- `codex/reader-parity` is the integration branch in both repositories. Main is
  unchanged. Each feature gets a matching branch and separate worktree in each
  repository, based on this integration branch.
- One feature implementer owns both platforms, its focused tests, and its
  documentation. Independent features can proceed in parallel. No concurrent
  writers share a checkout. Feature branches integrate serially after review;
  later branches incorporate the accepted baseline before resolving overlaps.
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

The baseline passed the full web unit and Chromium/WebKit suites, production
build and boundary checks, plus the Swift build and test suite. Real reader
controls were inspected on web and the iPhone simulator. Physical-device Dynamic
Island artwork remains unverified. The additive Swift segment preference fields
also require Development exercise and owner-coordinated Production CloudKit
schema deployment before distribution; see the Swift architecture document.

## Ordered backlog

| Order | Work | Implementation scope and review boundary |
| --- | --- | --- |
| 1, parallel | Typography | Matching EPUB and flowing-text controls for fonts, size, spacing, margins/width, and alignment. Reuse current settings and fonts. Review persistence and logical-location preservation before implementation. No PDF typography. Branch: `codex/reader-typography`. |
| 1, parallel | Voice favorites | Favorite/unfavorite and a favorites filter in existing voice pickers. Stable provider/model/voice identity, persistence, and unavailable-voice behavior come first. Favoriting never changes playback, downloads, or the current Apply workflow. Branch: `codex/voice-favorites`. |
| 2 | Highlight appearance | Colors, opacity, and presets using the independent word/segment layers. Start after typography integrates because renderer and settings ownership overlaps. Keep timing and cursor ownership unchanged. |
| 3 | Manual browsing and follow controls | Review cursor/playback separation first; delegate reader controls and navigation against that contract. Preserve canonical playback identity and existing readiness events. |
| 4 | Citation and bracket handling | Define source-to-spoken mapping and cache implications before preference UI. Text transformations must not invalidate word highlighting or stored progress silently. |
| 5 | Added web pauses | Establish the actual pause contract before implementation. Swift's existing controls refer to generated-piece and reader-block boundaries; these are not guaranteed sentence and paragraph boundaries. No Swift pause redesign is currently requested. |
| 6 | Optional external providers on Swift | Keep on-device reading the default. Establish secure configuration, credentials, and execution contracts first; implement adapters and UI afterward using existing web provider capabilities. |
| 7 | FishAudio | The only requested new provider. Implement both platforms after the provider contract exists; review credential handling and execution boundaries. |
| 8 | Optional queued voice changes | Preserve current Apply. Add a distinct queue option after specifying its interaction with generated audio, timeline reuse, and current playback. |

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

The completed baseline is committed on the paired integration branches. Separate
paired worktrees are prepared for typography and voice favorites. Their first
deliverable is a concrete contract grounded in existing code, including any
storage approval needed, before a feature expands its implementation scope.
