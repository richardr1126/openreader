/**
 * Canonical text-cleaning rules for the "audio" form of a sentence.
 *
 * This file is the single source of truth in the app. Two consumers apply these
 * rules:
 *  - `preprocessSentenceForAudio` (below) — the plain-string form used wherever
 *    TTS input text is produced.
 *  - `normalizeMappedChars` in `src/lib/client/highlight-char-map.ts` — a
 *    position-preserving variant that reuses the same patterns/glyph set so
 *    viewer highlight offsets line up with the audio text.
 *
 * The compute/worker package keeps its own mirror in
 * `compute/core/src/whisper/alignment-map.ts` (a separate build target that
 * cannot import from `@/lib`). Keep that copy in lock-step with these rules.
 */

/** Matches a bare or explicit URL token (http(s):// or www.). Capture 1 = domain. */
export const URL_PATTERN = /\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi;

/** Spoken-friendly stand-in for a stripped URL. */
export const linkReplacement = (domain: string): string => `- (link to ${domain}) -`;

/** Line-break hyphenation: "exam- ple" -> "example". Captures 1 + 2 = joined word. */
export const HYPHENATION_PATTERN = /([\p{L}\p{N}\p{M}]+)-\s+([\p{L}\p{N}\p{M}]+)/gu;

// Asterisk plus bullet / list-marker / decorative glyphs that carry no spoken
// value and cause strict TTS engines (e.g. supertonic) to reject the input with
// "unsupported character(s)". Both flavors below derive from this one list.
const STRIPPED_GLYPH_CHARS = '*•◦‣⁃∙▪▫■□●○◆◇★☆▶▸►▹➤➢❖';
const STRIPPED_GLYPH_SET = new Set(STRIPPED_GLYPH_CHARS);

/** Global regex for string `.replace`. */
export const STRIPPED_GLYPHS = new RegExp(`[${STRIPPED_GLYPH_CHARS}]`, 'g');

/** Stateless single-character membership test for the position-preserving path. */
export const isStrippedGlyph = (char: string): boolean => STRIPPED_GLYPH_SET.has(char);

/**
 * Preprocesses text for audio generation by cleaning up various artifacts:
 * rewrites URLs to a spoken form, joins line-break hyphenation, strips
 * decorative glyphs, and collapses whitespace.
 */
export const preprocessSentenceForAudio = (text: string): string =>
  text
    .replace(URL_PATTERN, (_match, domain: string) => linkReplacement(domain))
    .replace(HYPHENATION_PATTERN, '$1$2')
    .replace(STRIPPED_GLYPHS, '')
    .replace(/\s+/g, ' ')
    .trim();
