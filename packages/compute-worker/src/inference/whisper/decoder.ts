export function argmax(values: Float32Array): number | null {
  let bestIdx = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < values.length; i += 1) {
    const score = values[i];
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return Number.isFinite(bestScore) ? bestIdx : null;
}

export function applyTokenSuppression(logits: Float32Array, tokens: Set<number>) {
  for (const tokenId of tokens) {
    if (tokenId >= 0 && tokenId < logits.length) {
      logits[tokenId] = Number.NEGATIVE_INFINITY;
    }
  }
}

function logSoftmax(input: Float32Array): Float32Array {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] > max) max = input[i];
  }
  if (!Number.isFinite(max)) {
    return new Float32Array(input.length).fill(Number.NEGATIVE_INFINITY);
  }

  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += Math.exp(input[i] - max);
  }
  const logSum = Math.log(sum);

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] - max - logSum;
  }
  return out;
}

export function applyWhisperTimestampLogitsRules(input: {
  logits: Float32Array;
  generated: number[];
  beginIndex: number;
  eosTokenId: number;
  noTimestampsTokenId: number;
  timestampBeginTokenId: number;
  maxInitialTimestampIndex: number;
}) {
  const {
    logits,
    generated,
    beginIndex,
    eosTokenId,
    noTimestampsTokenId,
    timestampBeginTokenId,
    maxInitialTimestampIndex,
  } = input;

  if (noTimestampsTokenId >= 0 && noTimestampsTokenId < logits.length) {
    logits[noTimestampsTokenId] = Number.NEGATIVE_INFINITY;
  }

  if (generated.length === beginIndex) {
    const upper = Math.min(timestampBeginTokenId, logits.length);
    for (let i = 0; i < upper; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
  }

  const seq = generated.slice(beginIndex);
  const lastWasTimestamp = seq.length >= 1 && seq[seq.length - 1] >= timestampBeginTokenId;
  const penultimateWasTimestamp = seq.length < 2 || seq[seq.length - 2] >= timestampBeginTokenId;

  if (lastWasTimestamp) {
    if (penultimateWasTimestamp) {
      for (let i = timestampBeginTokenId; i < logits.length; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
    } else {
      const upper = Math.min(eosTokenId, logits.length);
      for (let i = 0; i < upper; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
    }
  }

  if (generated.length === beginIndex && Number.isFinite(maxInitialTimestampIndex)) {
    const lastAllowed = timestampBeginTokenId + maxInitialTimestampIndex;
    for (let i = lastAllowed + 1; i < logits.length; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
  }

  const textUpper = Math.min(timestampBeginTokenId, logits.length);
  if (textUpper <= 0 || textUpper >= logits.length) return;

  const logprobs = logSoftmax(logits);

  let maxTextTokenLogprob = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < textUpper; i += 1) {
    if (logprobs[i] > maxTextTokenLogprob) maxTextTokenLogprob = logprobs[i];
  }

  let timestampProbMass = 0;
  for (let i = textUpper; i < logprobs.length; i += 1) {
    timestampProbMass += Math.exp(logprobs[i]);
  }
  const timestampLogprob = timestampProbMass > 0 ? Math.log(timestampProbMass) : Number.NEGATIVE_INFINITY;

  if (timestampLogprob > maxTextTokenLogprob) {
    for (let i = 0; i < textUpper; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
  }
}
