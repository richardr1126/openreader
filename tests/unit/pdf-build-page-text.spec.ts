import { expect, test } from '@playwright/test';
import { buildPageTextFromBlocks } from '../../src/lib/client/pdf-block-text';
import type { ParsedPdfPage } from '../../src/types/parsed-pdf';

test.describe('buildPageTextFromBlocks', () => {
  test('filters skipped kinds and preserves reading order', () => {
    const page: ParsedPdfPage = {
      pageNumber: 1,
      width: 100,
      height: 100,
      blocks: [
        {
          id: 'b2',
          kind: 'page-header',
          text: 'Copyright Header',
          fragments: [{ page: 1, bbox: [0, 90, 100, 100], text: 'Copyright Header', readingOrder: 0 }],
        },
        {
          id: 'b1',
          kind: 'paragraph',
          text: 'Body text',
          fragments: [{ page: 1, bbox: [0, 20, 100, 80], text: 'Body text', readingOrder: 1 }],
        },
        {
          id: 'b3',
          kind: 'caption',
          text: 'Figure caption',
          fragments: [{ page: 1, bbox: [0, 5, 100, 19], text: 'Figure caption', readingOrder: 2 }],
        },
      ],
    };

    expect(buildPageTextFromBlocks(page, ['page-header'])).toBe('Body text Figure caption');
    expect(buildPageTextFromBlocks(page, ['page-header', 'caption'])).toBe('Body text');
  });
});
