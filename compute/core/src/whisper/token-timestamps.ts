import type { Tokenizer } from '@huggingface/tokenizers';
import type * as ort from 'onnxruntime-node';

const PUNCTUATION_REGEX = '\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E';
const PUNCTUATION_ONLY_REGEX = new RegExp(`^[${PUNCTUATION_REGEX}]+$`, 'gu');

type TokenTimestamp = [start: number, end: number];

export interface WhisperWordTiming {
  word: string;
  startSec: number;
  endSec: number;
}

function medianFilter(data: Float32Array, windowSize: number): Float32Array {
  if (windowSize % 2 === 0 || windowSize <= 0) {
    throw new Error('Window size must be a positive odd number');
  }

  const output = new Float32Array(data.length);
  const buffer = new Float32Array(windowSize);
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < data.length; i += 1) {
    let valuesIndex = 0;
    for (let j = -halfWindow; j <= halfWindow; j += 1) {
      let index = i + j;
      if (index < 0) {
        index = Math.abs(index);
      } else if (index >= data.length) {
        index = (2 * (data.length - 1)) - index;
      }
      buffer[valuesIndex] = data[index];
      valuesIndex += 1;
    }

    const sortable = Array.from(buffer);
    sortable.sort((a, b) => a - b);
    output[i] = sortable[halfWindow] ?? 0;
  }

  return output;
}

function dynamicTimeWarping(matrix: Float32Array[], rows: number, cols: number): [number[], number[]] {
  const cost: number[][] = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(Number.POSITIVE_INFINITY));
  const trace: number[][] = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(-1));
  cost[0][0] = 0;

  for (let j = 1; j <= cols; j += 1) {
    for (let i = 1; i <= rows; i += 1) {
      const c0 = cost[i - 1][j - 1];
      const c1 = cost[i - 1][j];
      const c2 = cost[i][j - 1];
      let c: number;
      let t: number;
      if (c0 < c1 && c0 < c2) {
        c = c0;
        t = 0;
      } else if (c1 < c0 && c1 < c2) {
        c = c1;
        t = 1;
      } else {
        c = c2;
        t = 2;
      }
      cost[i][j] = matrix[i - 1][j - 1] + c;
      trace[i][j] = t;
    }
  }

  for (let i = 0; i <= cols; i += 1) trace[0][i] = 2;
  for (let i = 0; i <= rows; i += 1) trace[i][0] = 1;

  let i = rows;
  let j = cols;
  const textIndices: number[] = [];
  const timeIndices: number[] = [];
  while (i > 0 || j > 0) {
    textIndices.push(i - 1);
    timeIndices.push(j - 1);
    const step = trace[i][j];
    if (step === 0) {
      i -= 1;
      j -= 1;
    } else if (step === 1) {
      i -= 1;
    } else if (step === 2) {
      j -= 1;
    } else {
      throw new Error(`Unexpected DTW trace state at [${i}, ${j}]`);
    }
  }

  textIndices.reverse();
  timeIndices.reverse();
  return [textIndices, timeIndices];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function decodeTokens(tokenizer: Pick<Tokenizer, 'decode'>, tokens: number[]): string {
  return tokenizer.decode(tokens, { skip_special_tokens: false });
}

function splitTokensOnUnicode(
  tokenizer: Pick<Tokenizer, 'decode'>,
  tokens: number[],
): [string[], number[][], number[][]] {
  const decodedFull = decodeTokens(tokenizer, tokens);
  const replacementChar = '\uFFFD';
  const words: string[] = [];
  const wordTokens: number[][] = [];
  const tokenIndices: number[][] = [];
  let currentTokens: number[] = [];
  let currentIndices: number[] = [];
  let unicodeOffset = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    currentTokens.push(tokens[i]);
    currentIndices.push(i);

    const decoded = decodeTokens(tokenizer, currentTokens);
    if (
      !decoded.includes(replacementChar)
      || decodedFull[unicodeOffset + decoded.indexOf(replacementChar)] === replacementChar
    ) {
      words.push(decoded);
      wordTokens.push(currentTokens);
      tokenIndices.push(currentIndices);
      currentTokens = [];
      currentIndices = [];
      unicodeOffset += decoded.length;
    }
  }

  return [words, wordTokens, tokenIndices];
}

function splitTokensOnSpaces(
  tokenizer: Pick<Tokenizer, 'decode'>,
  tokens: number[],
  eosTokenId: number,
): [string[], number[][], number[][]] {
  const [subwords, subwordTokens, subwordIndices] = splitTokensOnUnicode(tokenizer, tokens);
  const words: string[] = [];
  const wordTokens: number[][] = [];
  const tokenIndices: number[][] = [];

  for (let i = 0; i < subwords.length; i += 1) {
    const subword = subwords[i];
    const tokenList = subwordTokens[i];
    const indices = subwordIndices[i];
    const special = tokenList[0] >= eosTokenId;
    const withSpace = subword.startsWith(' ');
    const trimmed = subword.trim();
    const punctuation = PUNCTUATION_ONLY_REGEX.test(trimmed);

    if (special || withSpace || punctuation || words.length === 0) {
      words.push(subword);
      wordTokens.push([...tokenList]);
      tokenIndices.push([...indices]);
    } else {
      const ix = words.length - 1;
      words[ix] += subword;
      wordTokens[ix].push(...tokenList);
      tokenIndices[ix].push(...indices);
    }
  }

  return [words, wordTokens, tokenIndices];
}

function mergePunctuations(
  words: string[],
  tokens: number[][],
  indices: number[][],
  prependPunctuations = '"\'“¡¿([{-',
  appendPunctuations = '"\'.。,，!！?？:：”)]}、',
): [string[], number[][], number[][]] {
  const newWords = words.map((w) => `${w}`);
  const newTokens = tokens.map((t) => [...t]);
  const newIndices = indices.map((idx) => [...idx]);

  let i = newWords.length - 2;
  let j = newWords.length - 1;
  while (i >= 0) {
    if (newWords[i].startsWith(' ') && prependPunctuations.includes(newWords[i].trim())) {
      newWords[j] = newWords[i] + newWords[j];
      newTokens[j] = [...newTokens[i], ...newTokens[j]];
      newIndices[j] = [...newIndices[i], ...newIndices[j]];
      newWords[i] = '';
      newTokens[i] = [];
      newIndices[i] = [];
    } else {
      j = i;
    }
    i -= 1;
  }

  i = 0;
  j = 1;
  while (j < newWords.length) {
    if (!newWords[i].endsWith(' ') && appendPunctuations.includes(newWords[j])) {
      newWords[i] += newWords[j];
      newTokens[i] = [...newTokens[i], ...newTokens[j]];
      newIndices[i] = [...newIndices[i], ...newIndices[j]];
      newWords[j] = '';
      newTokens[j] = [];
      newIndices[j] = [];
    } else {
      i = j;
    }
    j += 1;
  }

  return [
    newWords.filter((w) => w.length > 0),
    newTokens.filter((t) => t.length > 0),
    newIndices.filter((t) => t.length > 0),
  ];
}

function combineTokensIntoWords(
  tokenizer: Pick<Tokenizer, 'decode'>,
  tokens: number[],
  eosTokenId: number,
  language = 'english',
): [string[], number[][], number[][]] {
  let words: string[];
  let wordTokens: number[][];
  let tokenIndices: number[][];

  if (['chinese', 'japanese', 'thai', 'lao', 'myanmar', 'zh', 'ja', 'th', 'lo', 'my'].includes(language)) {
    [words, wordTokens, tokenIndices] = splitTokensOnUnicode(tokenizer, tokens);
  } else {
    [words, wordTokens, tokenIndices] = splitTokensOnSpaces(tokenizer, tokens, eosTokenId);
  }

  return mergePunctuations(words, wordTokens, tokenIndices);
}

export function extractTokenStartTimestamps(input: {
  crossAttentions: Record<string, ort.Tensor>;
  decoderLayers: number;
  alignmentHeads: Array<[number, number]>;
  numFrames: number;
  numInputIds: number;
  timePrecision?: number;
  sequenceLength: number;
}): number[] {
  const {
    crossAttentions,
    decoderLayers,
    alignmentHeads,
    numFrames,
    numInputIds,
    timePrecision = 0.02,
    sequenceLength,
  } = input;

  const frameCount = Math.max(1, numFrames);
  const perLayer: Float32Array[] = [];
  for (let layer = 0; layer < decoderLayers; layer += 1) {
    const key = `cross_attentions.${layer}`;
    const tensor = crossAttentions[key];
    if (!tensor) continue;
    perLayer[layer] = tensor.data as Float32Array;
  }

  const selected: Float32Array[] = [];
  let seqLen = 0;
  let attnFrames = 0;
  for (const [layer, head] of alignmentHeads) {
    const flat = perLayer[layer];
    if (!flat) continue;
    const layerTensor = crossAttentions[`cross_attentions.${layer}`];
    if (!layerTensor || layerTensor.dims.length < 4) continue;
    const [, numHeads, currentSeqLen, currentFrames] = layerTensor.dims;
    if (head >= numHeads) continue;
    seqLen = currentSeqLen;
    attnFrames = Math.min(currentFrames, frameCount);
    const headSlice = new Float32Array(seqLen * attnFrames);
    for (let s = 0; s < seqLen; s += 1) {
      for (let f = 0; f < attnFrames; f += 1) {
        const flatIndex = (((head * currentSeqLen) + s) * currentFrames) + f;
        headSlice[(s * attnFrames) + f] = flat[flatIndex] ?? 0;
      }
    }
    selected.push(headSlice);
  }

  if (!selected.length || seqLen === 0 || attnFrames === 0) {
    return new Array(sequenceLength).fill(0);
  }

  const normalizedHeads = selected.map((headData) => {
    const means = new Float32Array(attnFrames);
    const stds = new Float32Array(attnFrames);

    for (let f = 0; f < attnFrames; f += 1) {
      let sum = 0;
      for (let s = 0; s < seqLen; s += 1) sum += headData[(s * attnFrames) + f];
      const mean = sum / seqLen;
      means[f] = mean;
      let varSum = 0;
      for (let s = 0; s < seqLen; s += 1) {
        const d = headData[(s * attnFrames) + f] - mean;
        varSum += d * d;
      }
      stds[f] = Math.sqrt(varSum / seqLen) || 1;
    }

    const out = new Float32Array(headData.length);
    for (let s = 0; s < seqLen; s += 1) {
      const row = new Float32Array(attnFrames);
      for (let f = 0; f < attnFrames; f += 1) {
        row[f] = (headData[(s * attnFrames) + f] - means[f]) / stds[f];
      }
      const filtered = medianFilter(row, 7);
      out.set(filtered, s * attnFrames);
    }
    return out;
  });

  const croppedRows = Math.max(0, seqLen - numInputIds);
  if (croppedRows === 0) return new Array(sequenceLength).fill(0);

  const matrix: Float32Array[] = Array.from({ length: croppedRows }, () => new Float32Array(attnFrames));
  for (const headData of normalizedHeads) {
    for (let r = 0; r < croppedRows; r += 1) {
      const srcRow = r + numInputIds;
      for (let f = 0; f < attnFrames; f += 1) {
        matrix[r][f] += headData[(srcRow * attnFrames) + f];
      }
    }
  }

  const scale = 1 / normalizedHeads.length;
  for (let r = 0; r < croppedRows; r += 1) {
    for (let f = 0; f < attnFrames; f += 1) {
      matrix[r][f] = -matrix[r][f] * scale;
    }
  }

  const [textIndices, timeIndices] = dynamicTimeWarping(matrix, croppedRows, attnFrames);
  const jumps = new Array(textIndices.length).fill(false);
  for (let i = 0; i < textIndices.length; i += 1) {
    jumps[i] = i === 0 ? true : textIndices[i] !== textIndices[i - 1];
  }

  const jumpTimes: number[] = [];
  for (let i = 0; i < jumps.length; i += 1) {
    if (jumps[i]) jumpTimes.push(timeIndices[i] * timePrecision);
  }

  const timestamps = new Array(sequenceLength).fill(0);
  for (let i = 0; i < numInputIds && i < timestamps.length; i += 1) timestamps[i] = 0;
  for (let i = 0; i < jumpTimes.length && (numInputIds + i) < timestamps.length; i += 1) {
    timestamps[numInputIds + i] = jumpTimes[i];
  }
  if (timestamps.length > 0 && jumpTimes.length > 0) {
    timestamps[timestamps.length - 1] = jumpTimes[jumpTimes.length - 1];
  }
  return timestamps;
}

export function buildWordsFromTimestampedTokens(input: {
  tokens: number[];
  tokenStartTimestamps: number[];
  tokenizer: Pick<Tokenizer, 'decode'>;
  eosTokenId: number;
  promptLength: number;
  timestampBeginTokenId: number;
  timePrecision?: number;
  language?: string;
}): WhisperWordTiming[] {
  const {
    tokens,
    tokenStartTimestamps,
    tokenizer,
    eosTokenId,
    promptLength,
    timestampBeginTokenId,
    timePrecision = 0.02,
    language = 'english',
  } = input;

  const limit = Math.min(tokens.length, tokenStartTimestamps.length);
  const tokenRanges: TokenTimestamp[] = [];
  for (let i = 0; i < limit; i += 1) {
    const start = tokenStartTimestamps[i] ?? 0;
    const end = i + 1 < limit ? (tokenStartTimestamps[i + 1] ?? (start + timePrecision)) : (start + timePrecision);
    tokenRanges.push([start, Math.max(start, end)]);
  }

  const words: WhisperWordTiming[] = [];
  let segmentStart: number | null = null;
  let textTokens: number[] = [];
  let textRanges: TokenTimestamp[] = [];

  const flushSegment = (segmentEnd: number | null) => {
    if (!textTokens.length) return;
    const [wordTexts, , tokenIndices] = combineTokensIntoWords(tokenizer, textTokens, eosTokenId, language);
    for (let i = 0; i < wordTexts.length; i += 1) {
      const indices = tokenIndices[i];
      if (!indices.length) continue;
      const start = textRanges[indices[0]]?.[0] ?? segmentStart ?? 0;
      const end = textRanges[indices[indices.length - 1]]?.[1] ?? segmentEnd ?? start;
      const clampedStart = segmentStart == null ? start : Math.max(segmentStart, start);
      const clampedEndBase = segmentEnd == null ? end : Math.min(segmentEnd, end);
      const clampedEnd = Math.max(
        clampedStart + (clampedEndBase <= clampedStart ? timePrecision : 0),
        clampedEndBase,
      );
      words.push({
        word: wordTexts[i].trim(),
        startSec: round2(clampedStart),
        endSec: round2(clampedEnd),
      });
    }
    textTokens = [];
    textRanges = [];
  };

  for (let i = promptLength; i < limit; i += 1) {
    const token = tokens[i];
    if (token === eosTokenId) break;

    if (token >= timestampBeginTokenId) {
      const ts = (token - timestampBeginTokenId) * timePrecision;
      if (segmentStart == null) {
        segmentStart = ts;
      } else {
        flushSegment(ts);
        segmentStart = ts;
      }
      continue;
    }

    textTokens.push(token);
    textRanges.push(tokenRanges[i]);
  }

  flushSegment(null);
  return words.filter((w) => w.word.length > 0);
}
