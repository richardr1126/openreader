import { describe, expect, test } from 'vitest';
import {
  applyTokenSuppression,
  applyWhisperTimestampLogitsRules,
  argmax,
} from '../../../src/inference/whisper/decoder';

describe('whisper decoder logits', () => {
  test('selects finite maximums and suppresses valid token ids', () => {
    const logits = new Float32Array([1, 5, 3]);

    applyTokenSuppression(logits, new Set([-1, 1, 10]));

    expect(argmax(logits)).toBe(2);
    expect(logits[1]).toBe(Number.NEGATIVE_INFINITY);
    expect(argmax(new Float32Array([Number.NEGATIVE_INFINITY]))).toBeNull();
  });

  test('forces an initial timestamp within the configured range', () => {
    const logits = new Float32Array([4, 3, 2, 1, 8, 7, 6, 5]);

    applyWhisperTimestampLogitsRules({
      logits,
      generated: [10, 11],
      beginIndex: 2,
      eosTokenId: 3,
      noTimestampsTokenId: 2,
      timestampBeginTokenId: 4,
      maxInitialTimestampIndex: 1,
    });

    expect(Array.from(logits.slice(0, 4))).toEqual([
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    expect(logits[4]).toBe(8);
    expect(logits[5]).toBe(7);
    expect(logits[6]).toBe(Number.NEGATIVE_INFINITY);
    expect(logits[7]).toBe(Number.NEGATIVE_INFINITY);
  });

  test('requires text after a timestamp pair', () => {
    const logits = new Float32Array([4, 3, 2, 1, 8, 7]);

    applyWhisperTimestampLogitsRules({
      logits,
      generated: [10, 4, 5],
      beginIndex: 1,
      eosTokenId: 3,
      noTimestampsTokenId: -1,
      timestampBeginTokenId: 4,
      maxInitialTimestampIndex: Number.POSITIVE_INFINITY,
    });

    expect(logits[4]).toBe(Number.NEGATIVE_INFINITY);
    expect(logits[5]).toBe(Number.NEGATIVE_INFINITY);
    expect(logits[0]).toBe(4);
  });
});
