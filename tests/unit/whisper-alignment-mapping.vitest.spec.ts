import { describe, expect, test } from 'vitest';
import {
  mapWordsToSentenceOffsets,
} from '@openreader/compute-core';

describe('whisper alignment mapping', () => {
  test('maps words to sentence offsets with punctuation and repeated spaces', () => {
    const aligned = mapWordsToSentenceOffsets('Hello, world  again.', [
      { word: 'Hello', start: 0, end: 0.25 },
      { word: 'world', start: 0.25, end: 0.5 },
      { word: 'again', start: 0.5, end: 1.0 },
    ]);

    expect(aligned.words).toHaveLength(3);
    expect(aligned.words[0].charStart).toBe(0);
    expect(aligned.words[0].charEnd).toBe(5);
    expect(aligned.words[1].charStart).toBeGreaterThan(aligned.words[0].charEnd);
    expect(aligned.words[2].charStart).toBeGreaterThan(aligned.words[1].charEnd);
    expect(aligned.words[2].charEnd).toBeLessThanOrEqual('Hello, world  again.'.length);
  });

  test('joins line-break hyphenation across unicode letters', () => {
    // "Über-\n mensch" must normalize to "Übermensch" so the offsets match the
    // client char map. This only works with the unicode-aware hyphen regex that
    // is kept in lock-step across nlp.ts / alignment-map.ts / highlight-char-map.ts.
    const aligned = mapWordsToSentenceOffsets('Über-\n mensch walks', [
      { word: 'Übermensch', start: 0, end: 0.5 },
      { word: 'walks', start: 0.5, end: 1.0 },
    ]);

    expect(aligned.words[0].charStart).toBe(0);
    expect(aligned.words[0].charEnd).toBe('Übermensch'.length);
    expect(aligned.words[1].charStart).toBeGreaterThanOrEqual(aligned.words[0].charEnd);
  });
});
