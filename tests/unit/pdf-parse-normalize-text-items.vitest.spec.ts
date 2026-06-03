import { describe, expect, test } from 'vitest';

import { normalizeTextItemsForLayout } from '@openreader/compute-core';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

function makeTextItem(
  str: string,
  transform: [number, number, number, number, number, number],
  width = 100,
): TextItem {
  return {
    str,
    transform,
    width,
    height: Math.abs(transform[3]),
    dir: 'ltr',
    fontName: 'test',
    hasEOL: false,
  } as unknown as TextItem;
}

describe('normalizeTextItemsForLayout', () => {
  test('keeps horizontal body text and drops rotated/skewed margin text', () => {
    const horizontal = makeTextItem(
      'Powered by large language models',
      [10, 0, 0, 10, 100, 600],
    );

    // Typical 90deg-ish rotated/skewed run (like side metadata labels).
    const rotated = makeTextItem(
      'arXiv:2407.16741v3 [cs.SE] 18 Apr 2025',
      [0, 10, -10, 0, 30, 400],
    );

    const normalized = normalizeTextItemsForLayout([horizontal, rotated], {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, {
      test: { ascent: 0.8, descent: -0.2 },
    });
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.text).toBe('Powered by large language models');
  });

  test('drops malformed/vertical-only runs so downstream layout planning sees no body text', () => {
    const vertical = makeTextItem('Side label', [0, 10, -10, 0, 30, 200]);
    const skewed = makeTextItem('Watermark', [10, 5, 2, 10, 200, 500]);

    const normalized = normalizeTextItemsForLayout([vertical, skewed], {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, {
      test: { ascent: 0.8, descent: -0.2 },
    });
    expect(normalized).toEqual([]);
  });

  test('accounts for non-zero page origins in the viewport transform', () => {
    const croppedPageLine = makeTextItem(
      'Vasher turned away.',
      [11.2, 0, 0, 11.2, 127.5, 644.4128],
      100,
    );

    const normalized = normalizeTextItemsForLayout([croppedPageLine], {
      height: 666.0074,
      transform: [1, 0, 0, -1, -53.4352, 720.565],
    }, {
      test: { ascent: 0.716, descent: -0.269 },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.x).toBeCloseTo(74.0648, 4);
    expect(normalized[0]?.y).toBeCloseTo(68.1356, 2);
  });

  test('uses font ascent to place decorative initials closer to the visible glyph top', () => {
    const dropCap = makeTextItem(
      'I',
      [60, 0, 0, 60, 111.1326, 434.46],
      9.18,
    );

    const normalized = normalizeTextItemsForLayout([dropCap], {
      height: 666.0074,
      transform: [1, 0, 0, -1, -53.4352, 720.565],
    }, {
      test: { ascent: 0.638, descent: -0.134 },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.y).toBeCloseTo(247.825, 3);
  });
});
