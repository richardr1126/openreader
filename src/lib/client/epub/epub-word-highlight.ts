import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment, TTSSentenceWord } from '@/types/tts';
import { normalizeUnicodeToken, segmentWords } from '@/lib/shared/language';

export type EpubCanonicalWordToken = {
  norm: string;
  sourceStart: number;
  sourceEnd: number;
};

export const normalizeWordForHighlight = (text: string): string =>
  normalizeUnicodeToken(text);

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

export const buildMonotonicWordToTokenMap = (
  alignmentWords: TTSSentenceAlignment['words'],
  segmentTokens: EpubCanonicalWordToken[],
): number[] => {
  const alignmentTokens = alignmentWords.map((word) => normalizeWordForHighlight(word.text));
  const wordToToken = new Array<number>(alignmentWords.length).fill(-1);
  const m = alignmentTokens.length;
  const n = segmentTokens.length;
  if (!m || !n) return wordToToken;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  const bt: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      let best = dp[i - 1][j - 1];
      let move = 0;

      const alignmentNorm = alignmentTokens[i - 1];
      const segmentNorm = segmentTokens[j - 1].norm;
      if (alignmentNorm && alignmentNorm === segmentNorm) {
        const positionPenalty =
          m <= 1 || n <= 1
            ? 0
            : Math.abs((i - 1) / (m - 1) - (j - 1) / (n - 1));
        best = dp[i - 1][j - 1] + 10 - positionPenalty;
        move = 1;
      }

      if (dp[i - 1][j] > best) {
        best = dp[i - 1][j];
        move = 2;
      }
      if (dp[i][j - 1] > best) {
        best = dp[i][j - 1];
        move = 3;
      }

      dp[i][j] = best;
      bt[i][j] = move;
    }
  }

  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const move = bt[i][j];
    if (move === 1) {
      wordToToken[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (move === 2) {
      i -= 1;
    } else if (move === 3) {
      j -= 1;
    } else {
      i -= 1;
      j -= 1;
    }
  }

  return wordToToken;
};

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
