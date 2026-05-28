import { test, expect } from '@playwright/test';
import * as ort from 'onnxruntime-node';
import {
  buildWordsFromTimestampedTokens,
  extractTokenStartTimestamps,
} from '@openreader/compute-core';

test.describe('whisper token timestamp alignment', () => {
  test('extracts monotonic token timestamps from cross-attention maps', () => {
    const seqLen = 6;
    const frames = 10;
    const heads = 8;
    const data = new Float32Array(1 * heads * seqLen * frames);
    for (let s = 0; s < seqLen; s += 1) {
      const peak = Math.min(frames - 1, s + 1);
      for (let f = 0; f < frames; f += 1) {
        const val = -Math.abs(f - peak);
        const idx = (((0 * seqLen) + s) * frames) + f;
        data[idx] = val;
      }
    }

    const cross = {
      'cross_attentions.0': new ort.Tensor('float32', data, [1, heads, seqLen, frames]),
    };

    const ts = extractTokenStartTimestamps({
      crossAttentions: cross,
      decoderLayers: 6,
      alignmentHeads: [[0, 0]],
      numFrames: frames,
      numInputIds: 3,
      sequenceLength: seqLen,
      timePrecision: 0.02,
    });

    expect(ts).toHaveLength(seqLen);
    expect(ts[0]).toBe(0);
    expect(ts[1]).toBe(0);
    expect(ts[2]).toBe(0);
    expect(ts[3]).toBeGreaterThanOrEqual(0);
    expect(ts[4]).toBeGreaterThanOrEqual(ts[3]);
    expect(ts[5]).toBeGreaterThanOrEqual(ts[4]);
  });

  test('builds word timings from token timestamps with punctuation merge', () => {
    const tokenText: Record<number, string> = {
      100: ' hello',
      101: ' world',
      102: '!',
    };
    const tokenizer = {
      decode(tokens: number[]) {
        return tokens.map((t) => tokenText[t] ?? '').join('');
      },
    };

    const timestampBeginTokenId = 50364;
    const tokens = [
      1, 2, 3,
      timestampBeginTokenId,
      100, 101, 102,
      timestampBeginTokenId + 50,
    ];
    const starts = [0, 0, 0, 0, 0.1, 0.3, 0.5, 1.0];

    const words = buildWordsFromTimestampedTokens({
      tokens,
      tokenStartTimestamps: starts,
      tokenizer,
      eosTokenId: 50257,
      promptLength: 3,
      timestampBeginTokenId,
      timePrecision: 0.02,
      language: 'en',
    });

    expect(words.length).toBe(2);
    expect(words[0].word.toLowerCase()).toContain('hello');
    expect(words[1].word.toLowerCase()).toContain('world');
    expect(words[1].word).toContain('!');
    expect(words[0].startSec).toBeGreaterThanOrEqual(0);
    expect(words[1].endSec).toBeGreaterThanOrEqual(words[1].startSec);
  });
});
