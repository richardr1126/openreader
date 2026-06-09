/**
 * Shared, position-preserving text normalizer for viewer highlighting.
 *
 * TTS word offsets (`charStart`/`charEnd`) are computed against the canonical
 * "audio" form of a sentence — URLs rewritten, line-break hyphenation joined,
 * `*` stripped, whitespace collapsed. To map those offsets back onto the
 * rendered DOM we have to normalize the DOM text the SAME way while remembering
 * which DOM position each surviving character came from.
 *
 * This module operates on an opaque position type so both the EPUB renderer
 * (position = `{ node, offset }` in an iframe) and the HTML/TXT renderer
 * (position = a `Text` node + offset in the main document) share one identical
 * normalization. Keep the transforms here in lock-step with
 * `preprocessSentenceForAudio` in `src/lib/shared/nlp.ts` and the copy in
 * `compute/core/src/whisper/alignment-map.ts`.
 */

export interface MappedChar<TPos> {
  char: string;
  pos: TPos;
}

const URL_PATTERN = /\S*(?:https?:\/\/|www\.)([^\/\s]+)(?:\/\S*)?/gi;
// Unicode-aware to match preprocessSentenceForAudio (nlp.ts / alignment-map.ts).
const HYPHENATION_PATTERN = /([\p{L}\p{N}\p{M}]+)-\s+([\p{L}\p{N}\p{M}]+)/gu;

const cloneMappedChar = <TPos>(char: string, source: MappedChar<TPos>): MappedChar<TPos> => ({
  char,
  pos: source.pos,
});

const replaceMappedUrls = <TPos>(tokens: MappedChar<TPos>[]): MappedChar<TPos>[] => {
  const text = tokens.map((token) => token.char).join('');
  const replaced: MappedChar<TPos>[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    replaced.push(...tokens.slice(cursor, start));

    const anchor = tokens[start] ?? tokens[Math.max(0, end - 1)];
    if (anchor) {
      const replacement = `- (link to ${match[1]}) -`;
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

  replaced.push(...tokens.slice(cursor));
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

    replaced.push(...tokens.slice(cursor, start));
    replaced.push(...tokens.slice(start, start + first.length));
    replaced.push(...tokens.slice(start + secondOffset, start + secondOffset + second.length));
    cursor = start + full.length;
  }

  replaced.push(...tokens.slice(cursor));
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
    if (token.char === '*') continue;
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
