import { describe, expect, test } from 'vitest';

import {
  buildAlignmentTokenRanges,
  findBestHighlightTokenMatch,
} from '../../src/lib/client/highlight-token-alignment';
import { segmentWords } from '../../src/lib/shared/language';
import type { TTSSentenceAlignment } from '../../src/types/tts';

const alignmentWords = (
  words: string[],
): TTSSentenceAlignment['words'] =>
  words.map((word, index) => ({
    text: word,
    startSec: index,
    endSec: index + 0.5,
    charStart: 0,
    charEnd: word.length,
  }));

describe('shared viewer highlight token alignment', () => {
  test('matches a complete Japanese sentence using locale-aware token count', () => {
    const sentence = 'これは日本語です。';
    const patternTokens = segmentWords(sentence, 'ja').map((token) => token.text);
    const tokenTexts = ['前文', ...patternTokens, '次文'];

    expect(findBestHighlightTokenMatch(patternTokens, tokenTexts)).toMatchObject({
      start: 1,
      end: patternTokens.length,
      lengthDiff: 0,
    });
  });

  test('matches spaced Latin text without relying on whitespace tokens', () => {
    expect(findBestHighlightTokenMatch(
      ['hello', 'world'],
      ['before', 'hello', 'world', 'after'],
    )).toMatchObject({
      start: 1,
      end: 2,
      lengthDiff: 0,
    });
  });

  test('maps a Japanese timed chunk across every visible token it spans', () => {
    expect(buildAlignmentTokenRanges(
      alignmentWords(['これは', '日本語', 'です']),
      ['これ', 'は', '日本語', 'です'],
    )).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 2 },
      { start: 3, end: 3 },
    ]);
  });

  test('maps visible chunks back to a larger timed Japanese token', () => {
    expect(buildAlignmentTokenRanges(
      alignmentWords(['これ', 'は', '日本語', 'です']),
      ['これは', '日本語', 'です'],
    )).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  test('maps repeated words monotonically', () => {
    expect(buildAlignmentTokenRanges(
      alignmentWords(['the', 'light', 'and', 'the', 'light']),
      ['the', 'light', 'and', 'the', 'light'],
    )).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 4 },
    ]);
  });

  test('can leave unrelated fallback tokens unmapped for strict viewers', () => {
    expect(buildAlignmentTokenRanges(
      alignmentWords(['alpha', 'missing', 'gamma']),
      ['alpha', 'beta', 'gamma'],
      { minimumSimilarity: 0.8 },
    )).toEqual([
      { start: 0, end: 0 },
      null,
      { start: 2, end: 2 },
    ]);
  });
});
