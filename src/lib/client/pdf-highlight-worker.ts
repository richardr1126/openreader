/// <reference lib="webworker" />

import { findBestHighlightTokenMatch } from './highlight-token-alignment';

interface TokenMatchRequest {
  id: string;
  type: 'tokenMatch';
  patternTokens: string[];
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

  const { id, patternTokens, tokenTexts } = data;
  const result = findBestHighlightTokenMatch(patternTokens, tokenTexts);

  const response: TokenMatchResponse = {
    id,
    type: 'tokenMatchResult',
    bestStart: result.start,
    bestEnd: result.end,
    rating: result.rating,
    lengthDiff: result.lengthDiff,
  };

  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
};
