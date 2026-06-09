import { describe, expect, test } from 'vitest';

import {
  resolveAlignmentWordSourceRange,
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

  test('rejects out-of-range alignment character offsets so the word is skipped', () => {
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

});
