import { describe, expect, test } from 'vitest';

import {
  resolveAlignmentWordSourceRange,
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

describe('EPUB word highlight mapping', () => {
  test('tokenizes Japanese and Chinese using locale-aware word boundaries', () => {
    const japanese = tokenizeCanonicalSegment(segment('これは日本語です。', 5), 'ja');
    expect(japanese.length).toBeGreaterThan(1);
    expect(japanese.every((token) => token.norm.length > 0)).toBe(true);

    const chinese = tokenizeCanonicalSegment(segment('这是中文。', 10), 'zh');
    expect(chinese.length).toBeGreaterThan(1);
    expect(chinese.map((token) => token.norm).join('')).toBe('这是中文');
  });

  test('resolves Japanese alignment chunks directly from character offsets', () => {
    const japanese = segment('これは日本語です。', 25);
    const word: TTSSentenceAlignment['words'][number] = {
      text: 'これは',
      startSec: 0,
      endSec: 0.5,
      charStart: 0,
      charEnd: 3,
    };

    expect(resolveAlignmentWordSourceRange(japanese, word)).toEqual({
      sourceStart: 25,
      sourceEnd: 28,
    });
  });

  test('rejects invalid alignment character offsets so token mapping can be used', () => {
    const japanese = segment('これは日本語です。', 25);
    const word: TTSSentenceAlignment['words'][number] = {
      text: '範囲外',
      startSec: 0,
      endSec: 0.5,
      charStart: 20,
      charEnd: 23,
    };

    expect(resolveAlignmentWordSourceRange(japanese, word)).toBeNull();
  });

  test('tokenizes canonical segment words with source offsets', () => {
    const tokens = tokenizeCanonicalSegment(segment('"Hello," she said.', 12));

    expect(tokens).toEqual([
      { norm: 'hello', sourceStart: 13, sourceEnd: 18 },
      { norm: 'she', sourceStart: 21, sourceEnd: 24 },
      { norm: 'said', sourceStart: 25, sourceEnd: 29 },
    ]);
  });

});
