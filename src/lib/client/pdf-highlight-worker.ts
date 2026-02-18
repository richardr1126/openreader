/// <reference lib="webworker" />

import { CmpStr } from 'cmpstr';

const cmp = CmpStr.create().setMetric('dice').setFlags('itw');

interface TokenMatchRequest {
  id: string;
  type: 'tokenMatch';
  pattern: string;
  tokenTexts: string[];
}

interface TokenMatchResponse {
  id: string;
  type: 'tokenMatchResult';
  bestStart: number;
  bestEnd: number;
  rating: number;
  lengthDiff: number;
}

/*
  Token Matching Worker

  This worker receives a pattern string and an array of token texts,
  and attempts to find the best matching contiguous sequence of tokens
  that aligns with the pattern.

  It uses the Dice coefficient string similarity metric to evaluate
  how closely different token windows match the pattern, adjusting
  for length differences and applying a prefix-alignment boost.

  The worker responds with the start and end indices of the best matching
  token window, along with its similarity rating and length difference.
*/

self.onmessage = (event: MessageEvent<TokenMatchRequest>) => {
  const data = event.data;
  if (!data || data.type !== 'tokenMatch') return;

  const { id, pattern, tokenTexts } = data;

  const cleanPattern = pattern.trim().replace(/\s+/g, ' ');
  const patternLen = cleanPattern.length;

  const responseBase: TokenMatchResponse = {
    id,
    type: 'tokenMatchResult',
    bestStart: -1,
    bestEnd: -1,
    rating: 0,
    lengthDiff: Number.POSITIVE_INFINITY,
  };

  if (!patternLen || !tokenTexts.length) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(responseBase);
    return;
  }

  const patternTokens = cleanPattern.split(' ').filter(Boolean);
  const patternTokenCount = patternTokens.length || 1;

  const minWindowTokens = Math.max(1, Math.floor(patternTokenCount * 0.6));
  const maxWindowTokens = Math.max(
    minWindowTokens,
    Math.ceil(patternTokenCount * 1.4)
  );

  let bestStart = -1;
  let bestEnd = -1;
  let bestRating = 0;
  let bestLengthDiff = Number.POSITIVE_INFINITY;

  for (let start = 0; start < tokenTexts.length; start++) {
    let combined = '';

    for (
      let offset = 0;
      offset < maxWindowTokens && start + offset < tokenTexts.length;
      offset++
    ) {
      const token = tokenTexts[start + offset];
      combined = combined ? `${combined} ${token}` : token;

      const windowSize = offset + 1;
      if (windowSize < minWindowTokens) continue;
      if (combined.length > patternLen * 2) break;

      const similarity = cmp.compare(combined, cleanPattern);
      const lengthDiff = Math.abs(combined.length - patternLen);
      const lengthPenalty = lengthDiff / patternLen;
      const adjustedRating = similarity * (1 - lengthPenalty * 0.3);

      // Prefix-alignment boost:
      // Favour windows whose first few tokens closely match the beginning
      // of the pattern, so we are less likely to cut off the first 1–2 words.
      let boostedRating = adjustedRating;
      if (patternTokens.length > 0) {
        const windowTokens = tokenTexts.slice(start, start + windowSize);
        const maxPrefixCheck = Math.min(
          windowTokens.length,
          patternTokens.length,
          5
        );

        let prefixMatches = 0;
        for (let i = 0; i < maxPrefixCheck; i++) {
          const tokenText = windowTokens[i];
          const patternToken = patternTokens[i];
          // Require reasonably strong similarity for a prefix match
          const tokenSim = cmp.compare(tokenText, patternToken);
          if (tokenSim >= 0.8) {
            prefixMatches++;
          } else {
            // Stop at the first non-matching leading token
            break;
          }
        }

        if (prefixMatches > 0) {
          const prefixRatio = prefixMatches / maxPrefixCheck;
          const PREFIX_BOOST_FACTOR = 0.25; // up to +25% boost
          boostedRating = adjustedRating * (1 + prefixRatio * PREFIX_BOOST_FACTOR);
        }
      }

      if (
        boostedRating > bestRating ||
        (Math.abs(boostedRating - bestRating) < 1e-3 &&
          lengthDiff < bestLengthDiff)
      ) {
        bestRating = boostedRating;
        bestLengthDiff = lengthDiff;
        bestStart = start;
        bestEnd = start + offset;
      }
    }
  }

  const response: TokenMatchResponse = {
    ...responseBase,
    bestStart,
    bestEnd,
    rating: bestRating,
    lengthDiff: bestLengthDiff,
  };

  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
};