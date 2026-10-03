/**
 * Shared, position-preserving text normalizer for viewer highlighting.
 *
 * TTS word offsets (`charStart`/`charEnd`) are computed against the canonical
 * "audio" form of a sentence — URLs rewritten, line-break hyphenation joined,
 * decorative glyphs stripped, whitespace collapsed. To map those offsets back
 * onto the rendered DOM we have to normalize the DOM text the SAME way while
 * remembering which DOM position each surviving character came from.
 *
 * The cleaning rules (patterns + glyph set) are imported from
 * `@openreader/tts/audio-text` so this position-preserving variant and the plain
 * string `preprocessSentenceForAudio` can never drift apart. This module only
 * owns the position-tracking mechanics.
 *
 * This module operates on an opaque position type so both the EPUB renderer
 * (position = `{ node, offset }` in an iframe) and the HTML/TXT renderer
 * (position = a `Text` node + offset in the main document) share one identical
 * normalization.
 */

import {
  HYPHENATION_PATTERN,
  URL_PATTERN,
  isStrippedGlyph,
  linkReplacement,
} from '@openreader/tts/audio-text';

export interface MappedChar<TPos> {
  char: string;
  pos: TPos;
}

const cloneMappedChar = <TPos>(char: string, source: MappedChar<TPos>): MappedChar<TPos> => ({
  char,
  pos: source.pos,
});

// Append by index, never by spreading: a long chapter has more characters than
// an engine accepts as call arguments, and iPad Safari's smaller stack overflows
// ("Maximum call stack size exceeded") where macOS does not.
const appendTokens = <TPos>(
  target: MappedChar<TPos>[],
  tokens: MappedChar<TPos>[],
  start: number,
  end = tokens.length,
): void => {
  const stop = Math.min(end, tokens.length);
  for (let index = Math.max(0, start); index < stop; index += 1) target.push(tokens[index]);
};

const replaceMappedUrls = <TPos>(tokens: MappedChar<TPos>[]): MappedChar<TPos>[] => {
  const text = tokens.map((token) => token.char).join('');
  const replaced: MappedChar<TPos>[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    appendTokens(replaced, tokens, cursor, start);

    const anchor = tokens[start] ?? tokens[Math.max(0, end - 1)];
    if (anchor) {
      const replacement = linkReplacement(match[1]);
      // Spread the replacement characters across the original URL span so the
      // mapped positions keep their positional spread instead of collapsing the
      // whole URL onto a single DOM anchor.
      const originalLength = Math.max(1, end - start);
      for (let i = 0; i < replacement.length; i += 1) {
        const sourceIndex = Math.min(end - 1, start + Math.floor((i * originalLength) / replacement.length));
        const source = tokens[sourceIndex] ?? anchor;
        replaced.push(cloneMappedChar(replacement[i], source));
      }
    }
    cursor = end;
  }

  appendTokens(replaced, tokens, cursor);
  return replaced;
};

const removeMappedHyphenation = <TPos>(tokens: MappedChar<TPos>[]): MappedChar<TPos>[] => {
  const text = tokens.map((token) => token.char).join('');
  const replaced: MappedChar<TPos>[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  HYPHENATION_PATTERN.lastIndex = 0;
  while ((match = HYPHENATION_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const full = match[0];
    const first = match[1];
    const second = match[2];
    const secondOffset = full.lastIndexOf(second);

    appendTokens(replaced, tokens, cursor, start);
    appendTokens(replaced, tokens, start, start + first.length);
    appendTokens(replaced, tokens, start + secondOffset, start + secondOffset + second.length);
    cursor = start + full.length;
  }

  appendTokens(replaced, tokens, cursor);
  return replaced;
};

/**
 * Normalize a position-tagged character stream into the canonical TTS form,
 * dropping/rewriting characters while preserving the source position of every
 * surviving character.
 */
export const normalizeMappedChars = <TPos>(tokens: MappedChar<TPos>[]): MappedChar<TPos>[] => {
  const withoutLinks = replaceMappedUrls(tokens);
  const withoutHyphenation = removeMappedHyphenation(withoutLinks);
  const normalized: MappedChar<TPos>[] = [];
  let pendingWhitespace: MappedChar<TPos> | null = null;

  const flushWhitespace = () => {
    if (!pendingWhitespace || normalized.length === 0 || normalized[normalized.length - 1].char === ' ') {
      pendingWhitespace = null;
      return;
    }
    normalized.push(cloneMappedChar(' ', pendingWhitespace));
    pendingWhitespace = null;
  };

  for (const token of withoutHyphenation) {
    if (isStrippedGlyph(token.char)) continue;
    if (/\s/.test(token.char)) {
      pendingWhitespace ??= token;
      continue;
    }

    flushWhitespace();
    normalized.push(token);
  }

  if (normalized[normalized.length - 1]?.char === ' ') {
    normalized.pop();
  }

  return normalized;
};
