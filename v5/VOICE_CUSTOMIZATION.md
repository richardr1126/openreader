# Added pauses and local voice customization — reader parity item 6

## Controls and defaults

Web app voice settings and per-book reader settings expose “Added pauses”.
“Between segments” adds silence after each canonical narration segment, for
all providers. With worker-local Kokoro, “Text grouping” also exposes a custom
piece-length target, and “Between pieces” adds silence between successful model
passes inside a segment. These are generated-piece and reader-block boundaries;
they are not guaranteed sentence or paragraph boundaries. External providers
own their internal splitting, so their piece controls are hidden and ignored.

Automatic preserves each engine's released behavior. The current web pipeline,
including local Kokoro, adds no fixed silence at either boundary: Automatic
therefore displays 0 ms. The voice's natural pauses remain untouched, including
when the user explicitly selects zero. No iOS pause policy is imported into the
web defaults. Swift retains its existing pause behavior; its “Advanced voice”
row and sheet are now titled “Advanced”.

Pause values range from 0 to 2,000 ms in 50 ms steps. Local piece length offers
a 50–450-character target in 25-character steps, preferring sentence and whole
word boundaries while retaining the existing 510-phoneme model limit. Automatic
keeps Kokoro's existing model-sized chunks. This does not change the canonical
reader plan or its maximum segment length.

Controls use compact inline rows with Automatic and numeric presets. A slider
appears in the control column only while editing a Custom value. App edits save
together through the existing voice settings Save/Discard bar. Book edits are
drafts; Save uses the existing regeneration confirmation. Closing the reader
settings discards unsaved customization. Each field inherits independently and
has a small reset icon beside its label when overridden. Explicit Automatic
(`null`) can override a numeric app default; an absent book field inherits.

## Reader settings organization and inheritance

On web, Advanced is one collapsed card containing local text grouping, added
pauses, and maximum narration segment length. Skip when reading aloud, with PDF
block kinds expanding inside it, lives in the voices panel below the voice list
(see `SPEECH_TEXT_HANDLING.md`). The per-document block overlay is a PDF Layout
switch in reader settings. Every overridden row shows the same `ResetButton`
beside its label. App defaults and book overrides use the existing preference
and document JSON. `playback.maxSegmentLength` overrides the app's segment
limit per book; PDF skip kinds inherit the app default when absent, while an
explicit empty array skips no block kinds. Existing saved arrays remain book
overrides. These audio-affecting book changes retain regeneration confirmation.

Display defaults live in global Reading settings, independently for PDF and
EPUB. Keyboard shortcuts live only there and apply to all readers. Book
`presentation` fields independently override layout, PDF page mode, EPUB theme,
and the segment/word highlight switches. Old global `readerShowsLayout` is
normalized into the two format defaults without changing its saved behavior.
Highlight switches live in Highlight appearance with colors and opacity; global
switch defaults remain independent for PDF, EPUB, and flowing text. Presentation
edits save without rebuilding audio, and unrelated speech edits preserve them.

Typography shows font family and text size first. More typography reveals
spacing, reading width, and alignment. Preset rows respond to the panel width,
so sidebar and phone layouts stack consistently. Themes occupy their own card,
collapsed to the current theme name and swatches. Theme, typography, Advanced,
PDF block disclosures, and the voice list's endless Show more animate measured height changes and respect reduced
motion. Their collapsed contents are inert and hidden from accessibility.
Animated contents use `overflow: clip` so focus scrolls the settings pane rather
than a hidden inner container. `overflow: hidden` allowed WebKit to move reset
buttons between pointer-down and pointer-up, intermittently dropping clicks.

## Audio, timing and persistence

Web stores `voiceCustomization` in the existing synced preference JSON and the
existing document-settings JSON. No SQL schema or migration is added. Its fields
are `pieceCharacterLimit`, `piecePauseMilliseconds` and
`blockPauseMilliseconds`, each numeric or null. An absent older value normalizes
to Automatic. Omitted customization is preserved during unrelated book edits.

Non-default effective customization contributes a versioned suffix to both
durable audio identity and in-memory synthesis deduplication. Automatic and
explicit zero retain the released keys, since both produce identical audio in
the current web engines. Local-only fields do not affect an external provider's
cache. Restoring previous settings reuses that audio through the normal cache
lifecycle; nothing purges the previous variant. Canonical text, ordinals,
anchors, bookmarks and reading locations remain unchanged.

Local Kokoro inserts PCM silence between successful chunks and at the segment
tail before the one MP3 encode. Absolute source-token spans include every
preceding gap, and the existing encoder-delay adjustment still applies once.
Cancelled generation stops before the next model pass; no model output or
silence is published after supersession. Empty speech-filtered segments keep
their existing short silence and make no provider request.

External provider audio is normalized as before, then receives whole CBR silence
frames at the segment tail. The requested pause is quantized to the nearest
26.1 ms MP3 frame (at most half a frame of rounding). Natural/provider silence
is never trimmed. Whisper aligns the stored audio, including the added tail.
Exact sidecar durations include all silence and are the common source for
streaming, seek layouts, highlighting and exports. Pending-slot estimates and
the stream's deterministic advertised upper bound also account for the added
silence, preventing a short segment with a long pause from being truncated.
Both timing readers decode stored JSON strings as well as settings objects, so
bootstrap, resumed sessions and worker streams use the same pause estimates.

MP3 and M4B exports reuse these same segment buffers and timings. Browser
playback rate speeds or slows added pauses along with the speech. Voice previews
use effective customization without entering the document cache. Existing SSE,
cursor, cancellation and backpressure owners are unchanged.
