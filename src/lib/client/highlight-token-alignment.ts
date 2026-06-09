import { CmpStr } from 'cmpstr';

import { normalizeUnicodeToken, segmentWords } from '@/lib/shared/language';
import type { TTSSentenceAlignment } from '@/types/tts';

const cmp = CmpStr.create().setMetric('dice').setFlags('itw');

export interface HighlightTokenRange {
  start: number;
  end: number;
}

/** A spoken word's resolved span as half-open `[start, end)` char offsets into a region of text. */
export interface AlignmentCharSpan {
  start: number;
  end: number;
}

export interface HighlightTokenMatchResult extends HighlightTokenRange {
  rating: number;
  lengthDiff: number;
}

export function normalizeHighlightToken(text: string): string {
  return normalizeUnicodeToken(text);
}

export function findBestHighlightTokenMatch(
  patternTokens: string[],
  tokenTexts: string[],
): HighlightTokenMatchResult {
  const normalizedPattern = patternTokens.map(normalizeHighlightToken).filter(Boolean);
  const normalizedTargets = tokenTexts.map(normalizeHighlightToken);
  const cleanPattern = normalizedPattern.join('');
  const patternLen = cleanPattern.length;
  const responseBase: HighlightTokenMatchResult = {
    start: -1,
    end: -1,
    rating: 0,
    lengthDiff: Number.POSITIVE_INFINITY,
  };

  if (!patternLen || !normalizedTargets.length) return responseBase;

  // Most viewer highlights are exact token sequences. Resolve those in one
  // linear pass before entering the fuzzy window search, which is expensive
  // enough to stall the UI when the target is a full HTML/TXT/MD document.
  const firstPatternToken = normalizedPattern[0];
  for (let start = 0; start < normalizedTargets.length; start += 1) {
    if (normalizedTargets[start] !== firstPatternToken) continue;
    let matches = true;
    for (let offset = 1; offset < normalizedPattern.length; offset += 1) {
      if (normalizedTargets[start + offset] !== normalizedPattern[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return {
        start,
        end: start + normalizedPattern.length - 1,
        rating: 1,
        lengthDiff: 0,
      };
    }
  }

  const patternTokenCount = normalizedPattern.length;
  const minWindowTokens = Math.max(1, Math.floor(patternTokenCount * 0.6));
  const maxWindowTokens = Math.max(
    minWindowTokens,
    Math.ceil(patternTokenCount * 1.4),
  );

  let bestStart = -1;
  let bestEnd = -1;
  let bestRating = 0;
  let bestLengthDiff = Number.POSITIVE_INFINITY;

  for (let start = 0; start < normalizedTargets.length; start += 1) {
    let combined = '';

    for (
      let offset = 0;
      offset < maxWindowTokens && start + offset < normalizedTargets.length;
      offset += 1
    ) {
      combined += normalizedTargets[start + offset];

      const windowSize = offset + 1;
      if (windowSize < minWindowTokens) continue;
      if (combined.length > patternLen * 2) break;

      const similarity = cmp.compare(combined, cleanPattern);
      const lengthDiff = Math.abs(combined.length - patternLen);
      const lengthPenalty = lengthDiff / patternLen;
      const adjustedRating = similarity * (1 - lengthPenalty * 0.3);

      let boostedRating = adjustedRating;
      const maxPrefixCheck = Math.min(windowSize, normalizedPattern.length, 5);
      let prefixMatches = 0;
      for (let i = 0; i < maxPrefixCheck; i += 1) {
        const tokenSim = cmp.compare(normalizedTargets[start + i], normalizedPattern[i]);
        if (tokenSim < 0.8) break;
        prefixMatches += 1;
      }

      if (prefixMatches > 0) {
        boostedRating = adjustedRating * (1 + (prefixMatches / maxPrefixCheck) * 0.25);
      }

      if (
        boostedRating > bestRating
        || (
          Math.abs(boostedRating - bestRating) < 1e-3
          && lengthDiff < bestLengthDiff
        )
      ) {
        bestRating = boostedRating;
        bestLengthDiff = lengthDiff;
        bestStart = start;
        bestEnd = start + offset;
      }
    }
  }

  return {
    start: bestStart,
    end: bestEnd,
    rating: bestRating,
    lengthDiff: bestLengthDiff,
  };
}

function buildExactConcatenatedRanges(
  alignmentNorms: string[],
  targetNorms: string[],
): Array<HighlightTokenRange | null> | null {
  if (alignmentNorms.join('') !== targetNorms.join('')) return null;

  const targetOffsets: HighlightTokenRange[] = [];
  let targetCursor = 0;
  for (const norm of targetNorms) {
    targetOffsets.push({ start: targetCursor, end: targetCursor + norm.length });
    targetCursor += norm.length;
  }

  const ranges: Array<HighlightTokenRange | null> = [];
  let alignmentCursor = 0;
  for (const norm of alignmentNorms) {
    const alignmentStart = alignmentCursor;
    const alignmentEnd = alignmentStart + norm.length;
    alignmentCursor = alignmentEnd;

    let first = -1;
    let last = -1;
    for (let i = 0; i < targetOffsets.length; i += 1) {
      const target = targetOffsets[i];
      if (target.end <= alignmentStart) continue;
      if (target.start >= alignmentEnd) break;
      if (first === -1) first = i;
      last = i;
    }
    ranges.push(first === -1 ? null : { start: first, end: last });
  }

  return ranges;
}

export function buildAlignmentTokenRanges(
  alignmentWords: TTSSentenceAlignment['words'],
  targetTexts: string[],
  options: { fillGaps?: boolean; minimumSimilarity?: number } = {},
): Array<HighlightTokenRange | null> {
  const alignmentNorms = alignmentWords.map((word) => normalizeHighlightToken(word.text));
  const targetNorms = targetTexts.map(normalizeHighlightToken);
  const ranges = new Array<HighlightTokenRange | null>(alignmentWords.length).fill(null);

  const exactRanges = buildExactConcatenatedRanges(alignmentNorms, targetNorms);
  if (exactRanges) return exactRanges;

  const targets = targetNorms
    .map((norm, tokenIndex) => ({ norm, tokenIndex }))
    .filter((token) => Boolean(token.norm));
  const alignments = alignmentNorms
    .map((norm, wordIndex) => ({ norm, wordIndex }))
    .filter((word) => Boolean(word.norm));
  const m = targets.length;
  const n = alignments.length;
  if (!m || !n) return ranges;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY),
  );
  const bt: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  dp[0][0] = 0;
  const gapCost = 0.7;

  for (let i = 0; i <= m; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      if (i > 0 && j > 0) {
        const a = targets[i - 1].norm;
        const b = alignments[j - 1].norm;
        const similarity = a === b ? 1 : cmp.compare(a, b);
        const candidate = dp[i - 1][j - 1] + (1 - similarity);
        if (candidate < dp[i][j]) {
          dp[i][j] = candidate;
          bt[i][j] = 0;
        }
      }
      if (i > 0 && dp[i - 1][j] + gapCost < dp[i][j]) {
        dp[i][j] = dp[i - 1][j] + gapCost;
        bt[i][j] = 1;
      }
      if (j > 0 && dp[i][j - 1] + gapCost < dp[i][j]) {
        dp[i][j] = dp[i][j - 1] + gapCost;
        bt[i][j] = 2;
      }
    }
  }

  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const move = bt[i][j];
    if (i > 0 && j > 0 && move === 0) {
      const tokenIndex = targets[i - 1].tokenIndex;
      const a = targets[i - 1].norm;
      const b = alignments[j - 1].norm;
      const similarity = a === b ? 1 : cmp.compare(a, b);
      if (similarity >= (options.minimumSimilarity ?? 0)) {
        ranges[alignments[j - 1].wordIndex] = { start: tokenIndex, end: tokenIndex };
      }
      i -= 1;
      j -= 1;
    } else if (i > 0 && (move === 1 || j === 0)) {
      i -= 1;
    } else if (j > 0 && (move === 2 || i === 0)) {
      j -= 1;
    } else {
      break;
    }
  }

  if (!options.fillGaps) return ranges;

  let lastSeen: HighlightTokenRange | null = null;
  for (let k = 0; k < ranges.length; k += 1) {
    if (ranges[k]) lastSeen = ranges[k];
    else if (lastSeen) ranges[k] = lastSeen;
  }
  let nextSeen: HighlightTokenRange | null = null;
  for (let k = ranges.length - 1; k >= 0; k -= 1) {
    if (ranges[k]) nextSeen = ranges[k];
    else if (nextSeen) ranges[k] = nextSeen;
  }

  return ranges;
}

/**
 * Map each spoken (Whisper-aligned) word onto a char span of an already-resolved
 * region of rendered text. This is the single word→DOM mapping primitive shared
 * by every viewer (EPUB, HTML/MD/TXT, PDF-style): the caller resolves the region
 * (a sentence wrap, a visible segment range) and supplies its text; we return,
 * for each word, the `[start, end)` char offsets to highlight within that text.
 *
 * The region text is tokenized into words and the spoken words are globally
 * aligned against those tokens via {@link buildAlignmentTokenRanges}. Working in
 * token space (not raw char offsets) means the result is robust to divergent
 * transcription, punctuation, casing, and whitespace; `fillGaps` guarantees
 * every word resolves to a neighboring token rather than dropping out.
 */
export function locateAlignmentWordSpans(
  words: TTSSentenceAlignment['words'],
  regionText: string,
  language?: string | null,
): Array<AlignmentCharSpan | null> {
  const tokens = segmentWords(regionText, language);
  if (!words.length) return [];
  if (!tokens.length) return words.map(() => null);

  const tokenRanges = buildAlignmentTokenRanges(
    words,
    tokens.map((token) => token.text),
    { fillGaps: true },
  );

  return tokenRanges.map((range) =>
    range ? { start: tokens[range.start].start, end: tokens[range.end].end } : null,
  );
}
