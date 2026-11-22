import { describe, expect, test } from 'vitest';

import type { ParsedPdfDocument } from '../../src/types/parsed-pdf';
import { pdfPartWordRange, pdfSegmentPageAt, resolvePdfSegmentPageParts } from '../../src/lib/client/pdf/segment-pages';

const tailText = 'He kept the light alive, and on cold nights he stayed awake until the dawn';
const continuation = 'broke over the grey water.';

// The shape stitching leaves behind: the tail block on page 1 gains a
// fragment on page 2 holding the text that finishes its last sentence.
const stitched = {
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      blocks: [{
        id: 'b1',
        kind: 'text',
        text: `${tailText} ${continuation}`,
        fragments: [
          { page: 1, bbox: [0, 600, 500, 700], text: tailText, readingOrder: 3 },
          { page: 2, bbox: [0, 40, 500, 120], text: continuation, readingOrder: 0 },
        ],
      }],
    },
  ],
} as unknown as ParsedPdfDocument;

const locator = { readerType: 'pdf', page: 1, blockId: 'b1' } as const;

describe('PDF segment page parts', () => {
  test('splits a sentence that runs over a page break by page', () => {
    const sentence = 'and on cold nights he stayed awake until the dawn broke over the grey water.';
    const parts = resolvePdfSegmentPageParts(stitched, locator, sentence);
    expect(parts.map(({ page, text }) => ({ page, text }))).toEqual([
      { page: 1, text: 'and on cold nights he stayed awake until the dawn' },
      { page: 2, text: 'broke over the grey water.' },
    ]);
    expect(sentence.slice(parts[1].start, parts[1].end)).toBe('broke over the grey water.');

    expect(pdfSegmentPageAt(parts, 0)).toBe(1);
    expect(pdfSegmentPageAt(parts, sentence.indexOf('dawn'))).toBe(1);
    expect(pdfSegmentPageAt(parts, sentence.indexOf('broke'))).toBe(2);
  });

  test('places a segment wholly after the break on the next page', () => {
    const parts = resolvePdfSegmentPageParts(stitched, locator, 'broke over the grey water.');
    expect(parts.map((part) => part.page)).toEqual([2]);
  });

  test('keeps a sentence before the break, or an unplaceable one, on the locator page', () => {
    expect(resolvePdfSegmentPageParts(stitched, locator, 'He kept the light alive,')
      .map((part) => part.page)).toEqual([1]);
    expect(resolvePdfSegmentPageParts(stitched, locator, 'Text the block does not contain.'))
      .toEqual([{ page: 1, start: 0, end: 32, text: 'Text the block does not contain.' }]);
  });
});

test('places the copy of a repeated sentence that the segment starts at', () => {
  const repeated = 'the dawn broke.';
  const doc = {
    pages: [{
      pageNumber: 1,
      width: 612,
      height: 792,
      blocks: [{
        id: 'b1',
        kind: 'text',
        text: `${repeated} Then night, and the dawn broke.`,
        fragments: [
          { page: 1, bbox: [0, 600, 500, 700], text: `${repeated} Then night, and the dawn`, readingOrder: 3 },
          { page: 2, bbox: [0, 40, 500, 120], text: 'broke.', readingOrder: 0 },
        ],
      }],
    }],
  } as unknown as ParsedPdfDocument;
  const blockText = doc.pages[0].blocks[0].text;
  expect(resolvePdfSegmentPageParts(doc, locator, repeated, 0).map((part) => part.page)).toEqual([1]);
  expect(resolvePdfSegmentPageParts(doc, locator, repeated, blockText.lastIndexOf(repeated))
    .map((part) => part.page)).toEqual([1, 2]);
});

describe('PDF page word range', () => {
  test('selects the spoken words that start within a page part', () => {
    const part = { page: 2, start: 10, end: 30, text: 'x' };
    const spans = [{ start: 0 }, { start: 6 }, null, { start: 10 }, { start: 22 }, { start: 30 }];
    expect(pdfPartWordRange(spans, part)).toEqual({ first: 3, last: 4 });
    expect(pdfPartWordRange([{ start: 0 }], part)).toBeNull();
  });
});
