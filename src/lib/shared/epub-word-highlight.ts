import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment } from '@/types/tts';

export type EpubCanonicalWordToken = {
  norm: string;
  sourceStart: number;
  sourceEnd: number;
};

export const normalizeWordForHighlight = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

export const tokenizeCanonicalSegment = (segment: CanonicalTtsSegment): EpubCanonicalWordToken[] => {
  const tokens: EpubCanonicalWordToken[] = [];
  const wordRegex = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = wordRegex.exec(segment.text)) !== null) {
    const raw = match[0];
    const leading = raw.match(/^[^A-Za-z0-9]*/)?.[0].length ?? 0;
    const trailing = raw.match(/[^A-Za-z0-9]*$/)?.[0].length ?? 0;
    const start = match.index + leading;
    const end = match.index + raw.length - trailing;
    if (end <= start) continue;

    const norm = normalizeWordForHighlight(raw.slice(leading, raw.length - trailing));
    if (!norm) continue;

    tokens.push({
      norm,
      sourceStart: segment.startAnchor.offset + start,
      sourceEnd: segment.startAnchor.offset + end,
    });
  }

  return tokens;
};

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
): string =>
  [
    segment.key,
    segment.text.length,
    alignment.words.length,
    alignment.words.map((word) => normalizeWordForHighlight(word.text)).join('|'),
  ].join('::');
