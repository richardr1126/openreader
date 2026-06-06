import { CmpStr } from 'cmpstr';

const cmp = CmpStr.create().setMetric('dice').setFlags('itw');

export interface HighlightTokenMatchResult {
  bestStart: number;
  bestEnd: number;
  rating: number;
  lengthDiff: number;
}

export function findBestHighlightTokenMatch(
  patternTokens: string[],
  tokenTexts: string[],
): HighlightTokenMatchResult {
  const cleanPatternTokens = patternTokens.map((token) => token.trim()).filter(Boolean);
  const cleanPattern = cleanPatternTokens.join('');
  const patternLen = cleanPattern.length;
  const responseBase: HighlightTokenMatchResult = {
    bestStart: -1,
    bestEnd: -1,
    rating: 0,
    lengthDiff: Number.POSITIVE_INFINITY,
  };

  if (!patternLen || !tokenTexts.length) return responseBase;

  const patternTokenCount = cleanPatternTokens.length;
  const minWindowTokens = Math.max(1, Math.floor(patternTokenCount * 0.6));
  const maxWindowTokens = Math.max(
    minWindowTokens,
    Math.ceil(patternTokenCount * 1.4),
  );

  let bestStart = -1;
  let bestEnd = -1;
  let bestRating = 0;
  let bestLengthDiff = Number.POSITIVE_INFINITY;

  for (let start = 0; start < tokenTexts.length; start += 1) {
    let combined = '';

    for (
      let offset = 0;
      offset < maxWindowTokens && start + offset < tokenTexts.length;
      offset += 1
    ) {
      const token = tokenTexts[start + offset];
      combined += token;

      const windowSize = offset + 1;
      if (windowSize < minWindowTokens) continue;
      if (combined.length > patternLen * 2) break;

      const similarity = cmp.compare(combined, cleanPattern);
      const lengthDiff = Math.abs(combined.length - patternLen);
      const lengthPenalty = lengthDiff / patternLen;
      const adjustedRating = similarity * (1 - lengthPenalty * 0.3);

      let boostedRating = adjustedRating;
      const windowTokens = tokenTexts.slice(start, start + windowSize);
      const maxPrefixCheck = Math.min(
        windowTokens.length,
        cleanPatternTokens.length,
        5,
      );

      let prefixMatches = 0;
      for (let i = 0; i < maxPrefixCheck; i += 1) {
        const tokenSim = cmp.compare(windowTokens[i], cleanPatternTokens[i]);
        if (tokenSim < 0.8) break;
        prefixMatches += 1;
      }

      if (prefixMatches > 0) {
        const prefixRatio = prefixMatches / maxPrefixCheck;
        boostedRating = adjustedRating * (1 + prefixRatio * 0.25);
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
    bestStart,
    bestEnd,
    rating: bestRating,
    lengthDiff: bestLengthDiff,
  };
}
