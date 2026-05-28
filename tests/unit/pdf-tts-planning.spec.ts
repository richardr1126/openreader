import { expect, test } from '@playwright/test';

import { buildPdfPageSourceUnits, buildPdfPrefetchPayload } from '../../src/lib/client/pdf-tts-planning';
import type { ParsedPdfPage } from '../../src/types/parsed-pdf';

function buildPage(pageNumber: number): ParsedPdfPage {
  return {
    pageNumber,
    width: 800,
    height: 1200,
    blocks: [
      {
        id: `h-${pageNumber}`,
        kind: 'header',
        text: 'Header text',
        fragments: [{ page: pageNumber, bbox: [0, 0, 1, 1], text: 'Header text', readingOrder: 0 }],
      },
      {
        id: `p-${pageNumber}-a`,
        kind: 'text',
        text: `Paragraph A on page ${pageNumber}.`,
        // Regression guard: fragment page can drift; locator must stay pinned
        // to the requested page number for stable planning/grouping.
        fragments: [{ page: pageNumber + 100, bbox: [0, 0, 1, 1], text: 'x', readingOrder: 1 }],
      },
      {
        id: `p-${pageNumber}-b`,
        kind: 'paragraph_title',
        text: `Section title ${pageNumber}`,
        fragments: [{ page: pageNumber, bbox: [0, 0, 1, 1], text: 'y', readingOrder: 2 }],
      },
      {
        id: `empty-${pageNumber}`,
        kind: 'text',
        text: '   ',
        fragments: [{ page: pageNumber, bbox: [0, 0, 1, 1], text: 'z', readingOrder: 3 }],
      },
    ],
  };
}

test.describe('pdf tts planning helpers', () => {
  test('buildPdfPageSourceUnits uses parsed blocks, honors skip kinds, and pins locator page', () => {
    const page = buildPage(2);
    const units = buildPdfPageSourceUnits(page, 2, ['header']);

    expect(units.map((u) => u.sourceKey)).toEqual([
      'pdf:2:p-2-a',
      'pdf:2:p-2-b',
    ]);
    expect(units.map((u) => u.text)).toEqual([
      'Paragraph A on page 2.',
      'Section title 2',
    ]);
    expect(units.map((u) => u.locator)).toEqual([
      { readerType: 'pdf', page: 2, blockId: 'p-2-a' },
      { readerType: 'pdf', page: 2, blockId: 'p-2-b' },
    ]);
  });

  test('buildPdfPrefetchPayload includes parsed sourceUnits for next and upcoming pages', () => {
    const pages = new Map<number, ParsedPdfPage>([
      [2, buildPage(2)],
      [3, buildPage(3)],
      [4, buildPage(4)],
    ]);
    const payload = buildPdfPrefetchPayload(
      [2, 3, 4],
      ['Page 2 text', 'Page 3 text', 'Page 4 text'],
      (pageNum) => buildPdfPageSourceUnits(pages.get(pageNum), pageNum, ['header']),
    );

    expect(payload.nextText).toBe('Page 2 text');
    expect(payload.nextSourceUnits.map((u) => u.sourceKey)).toEqual([
      'pdf:2:p-2-a',
      'pdf:2:p-2-b',
    ]);
    expect(payload.additionalUpcoming).toHaveLength(2);
    expect(payload.additionalUpcoming[0]).toMatchObject({
      location: 3,
      text: 'Page 3 text',
    });
    expect(payload.additionalUpcoming[0].sourceUnits.map((u) => u.sourceKey)).toEqual([
      'pdf:3:p-3-a',
      'pdf:3:p-3-b',
    ]);
    expect(payload.additionalUpcoming[1].sourceUnits.map((u) => u.sourceKey)).toEqual([
      'pdf:4:p-4-a',
      'pdf:4:p-4-b',
    ]);
  });

  test('buildPdfPrefetchPayload drops blank upcoming text entries', () => {
    const pages = new Map<number, ParsedPdfPage>([
      [2, buildPage(2)],
      [3, buildPage(3)],
    ]);
    const payload = buildPdfPrefetchPayload(
      [2, 3],
      ['Page 2 text', '   '],
      (pageNum) => buildPdfPageSourceUnits(pages.get(pageNum), pageNum, ['header']),
    );

    expect(payload.nextText).toBe('Page 2 text');
    expect(payload.additionalUpcoming).toHaveLength(0);
  });
});
