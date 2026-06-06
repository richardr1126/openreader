import { describe, expect, test } from 'vitest';

import { findBestHighlightTokenMatch } from '../../src/lib/client/pdf-highlight-match';
import { segmentWords } from '../../src/lib/shared/language';

describe('PDF highlight token matching', () => {
  test('matches a complete Japanese sentence using locale-aware token count', () => {
    const sentence = 'これは日本語です。';
    const patternTokens = segmentWords(sentence, 'ja').map((token) => token.text);
    const tokenTexts = ['前文', ...patternTokens, '次文'];

    expect(findBestHighlightTokenMatch(patternTokens, tokenTexts)).toMatchObject({
      bestStart: 1,
      bestEnd: patternTokens.length,
      lengthDiff: 0,
    });
  });

  test('matches spaced Latin text without relying on whitespace tokens', () => {
    expect(findBestHighlightTokenMatch(
      ['hello', 'world'],
      ['before', 'hello', 'world', 'after'],
    )).toMatchObject({
      bestStart: 1,
      bestEnd: 2,
      lengthDiff: 0,
    });
  });
});
