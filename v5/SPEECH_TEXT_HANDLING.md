# Speech text handling — reader parity item 5

## Controls

All readers expose two rows under “Skip when reading aloud”:

- Citations: off/on, covering numeric reference groups such as `[1, 3–5]`
  and parenthetical author–year citations such as `(Smith, 2024)`.
- Bracketed text: off, square brackets, parentheses, or both.

Web places app defaults below the voice picker. Both app and book controls use
the existing settings list rows with leading icons and ⓘ help popovers; examples
and explanations belong in those popovers rather than extra descriptive rows.

Both default to off. App defaults and per-book overrides inherit independently;
the book reset icons restore inheritance. PDFs show these rows alongside the
existing block-kind controls. Swift does not add PDF semantic classification.

Detection is deterministic. Bare numbers and years remain spoken. Citation
detection requires an entire balanced group to match the numeric or author–year
form. General bracket skipping handles nesting and multi-sentence passages;
unmatched opening brackets are preserved. Bracket context resets at a section
boundary, so malformed text cannot suppress later EPUB chapters or PDF pages.

## Source, timing and cache contract

The canonical plan text, segment keys, ordinals, source anchors, visible text,
bookmarks and stored reading locations remain unchanged. Speech filtering is
derived from the full ordered plan before selecting a generation window, so
seeking into the middle of a bracketed passage has the same result as playing
through it. The result carries an exact spoken-to-source character map. Both
provider word timings and subsequent alignment are mapped back to the original
segment before publication or persistence. The renderer continues using source
text; repeated words in omitted prose must not misdirect alignment.

Filtered audio is a separate settings variant. With both controls off, cache
hashes retain their released values. With filtering enabled, keys include the
filter version, effective options and actual spoken text: a sentence inside a
multi-segment bracket can have different speech from an identical sentence
outside it. Fully omitted segments become short silence without a provider
request. Original audio remains reusable when settings are restored. Settings
apply through the existing confirmation and cancellation owners.

## Approved additive storage

Web uses the existing synced preference JSON (`speechText`) and document JSON
(`speechText` containing optional per-field overrides); no SQL migration.

Swift adds one optional SwiftData field (approved by the owner):
`LibraryDocument.speechTextOverrideData: Data?`. It contains only this feature's
per-field overrides and its modification timestamp. App defaults use a dedicated
UserDefaults key and timestamp. The existing CloudKit `ReaderLanguage` and
`ReaderSpeechPreferences` records gain optional `speechText` data fields; the
global record also gains `speechTextModifiedAt`. The sync journal gains separate
optional upload clocks, retaining the existing voice/language clocks' meaning.
Older records with no fields preserve local settings. These CloudKit fields
require owner-coordinated Production schema deployment before distribution.
