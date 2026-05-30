import { describe, expect, test } from 'vitest';

import {
  buildMonotonicWordToTokenMap,
  tokenizeCanonicalSegment,
} from '../../src/lib/client/epub/epub-word-highlight';
import type { CanonicalTtsSegment } from '../../src/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment } from '../../src/types/tts';

const segment = (text: string, offset = 0): CanonicalTtsSegment => ({
  key: `segment:${offset}:${text}`,
  ordinal: 0,
  text,
  ownerSourceKey: 'str:epubcfi(/6/2)',
  ownerLocator: { location: 'epubcfi(/6/2)', readerType: 'epub' },
  startAnchor: { sourceKey: 'str:epubcfi(/6/2)', offset },
  endAnchor: { sourceKey: 'str:epubcfi(/6/2)', offset: offset + text.length },
  spansSourceBoundary: false,
});

const alignmentWords = (words: string[]): TTSSentenceAlignment['words'] =>
  words.map((word, index) => ({
    text: word,
    startSec: index,
    endSec: index + 0.5,
    charStart: 0,
    charEnd: word.length,
  }));

describe('EPUB word highlight mapping', () => {
  test('tokenizes canonical segment words with source offsets', () => {
    const tokens = tokenizeCanonicalSegment(segment('"Hello," she said.', 12));

    expect(tokens).toEqual([
      { norm: 'hello', sourceStart: 13, sourceEnd: 18 },
      { norm: 'she', sourceStart: 21, sourceEnd: 24 },
      { norm: 'said', sourceStart: 25, sourceEnd: 29 },
    ]);
  });

  test('maps repeated words monotonically instead of jumping to later duplicates', () => {
    const tokens = tokenizeCanonicalSegment(segment('the light and the shadow and the light returned'));
    const map = buildMonotonicWordToTokenMap(
      alignmentWords(['the', 'light', 'and', 'the', 'shadow', 'and', 'the', 'light', 'returned']),
      tokens,
    );

    expect(map).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('leaves unmatched alignment words unhighlighted instead of borrowing a neighbor', () => {
    const tokens = tokenizeCanonicalSegment(segment('alpha beta gamma'));
    const map = buildMonotonicWordToTokenMap(
      alignmentWords(['alpha', 'missing', 'gamma']),
      tokens,
    );

    expect(map).toEqual([0, -1, 2]);
  });
});
