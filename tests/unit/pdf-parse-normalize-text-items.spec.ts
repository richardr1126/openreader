import { expect, test } from '@playwright/test';

import { normalizeTextItemsForLayout } from '../../src/lib/server/pdf-layout/parsePdf';
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

test.describe('normalizeTextItemsForLayout', () => {
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

    const normalized = normalizeTextItemsForLayout([horizontal, rotated], 800);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.text).toBe('Powered by large language models');
  });
});

