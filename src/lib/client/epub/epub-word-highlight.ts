import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment, TTSSentenceWord } from '@/types/tts';
import { segmentWords } from '@/lib/shared/language';
import { normalizeHighlightToken } from '@/lib/client/highlight-token-alignment';

export type EpubCanonicalWordToken = {
  norm: string;
  sourceStart: number;
  sourceEnd: number;
};

export const normalizeWordForHighlight = (text: string): string =>
  normalizeHighlightToken(text);

export const resolveAlignmentWordSourceRange = (
  segment: CanonicalTtsSegment,
  word: TTSSentenceWord,
): { sourceStart: number; sourceEnd: number } | null => {
  const { charStart, charEnd } = word;
  if (!Number.isInteger(charStart) || !Number.isInteger(charEnd)) return null;
  if (charStart < 0 || charEnd <= charStart || charEnd > segment.text.length) return null;

  return {
    sourceStart: segment.startAnchor.offset + charStart,
    sourceEnd: segment.startAnchor.offset + charEnd,
  };
};

export const tokenizeCanonicalSegment = (
  segment: CanonicalTtsSegment,
  language?: string,
): EpubCanonicalWordToken[] =>
  segmentWords(segment.text, language)
    .map((token) => ({
      norm: normalizeWordForHighlight(token.text),
      sourceStart: segment.startAnchor.offset + token.start,
      sourceEnd: segment.startAnchor.offset + token.end,
    }))
    .filter((token) => Boolean(token.norm));

export const buildWordHighlightCacheKey = (
  segment: CanonicalTtsSegment,
  alignment: TTSSentenceAlignment,
  language?: string,
): string =>
  [
    segment.key,
    segment.text.length,
    language || '',
    alignment.words.length,
    alignment.words.map((word) => normalizeWordForHighlight(word.text)).join('|'),
  ].join('::');
