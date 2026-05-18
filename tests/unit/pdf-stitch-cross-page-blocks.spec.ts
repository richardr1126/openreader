import { expect, test } from '@playwright/test';
import { stitchCrossPageBlocks } from '../../src/lib/server/pdf-layout/stitchCrossPageBlocks';
import type { ParsedPdfBlock, ParsedPdfDocument, ParsedPdfBlockKind } from '../../src/types/parsed-pdf';

function makeBlock(
  id: string,
  kind: ParsedPdfBlockKind,
  text: string,
  page: number,
  readingOrder: number,
): ParsedPdfBlock {
  return {
    id,
    kind,
    text,
    fragments: [{
      page,
      bbox: [0, 0, 100, 10],
      text,
      readingOrder,
    }],
  };
}

function makeDoc(page1Blocks: ParsedPdfBlock[], page2Blocks: ParsedPdfBlock[]): ParsedPdfDocument {
  return {
    schemaVersion: 1,
    documentId: 'doc',
    parserVersion: 'test',
    parsedAt: 0,
    pages: [
      { pageNumber: 1, width: 100, height: 100, blocks: page1Blocks },
      { pageNumber: 2, width: 100, height: 100, blocks: page2Blocks },
    ],
  };
}

test.describe('stitchCrossPageBlocks', () => {
  test('stitches paragraph continuation across footer/header noise', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'paragraph', 'This sentence continues', 1, 0),
        makeBlock('b2', 'page-footer', 'Footer text', 1, 1),
      ],
      [
        makeBlock('b3', 'page-header', 'Header text', 2, 0),
        makeBlock('b4', 'paragraph', 'into the next page.', 2, 1),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    const page1 = stitched.pages[0];
    const page2 = stitched.pages[1];

    expect(page1?.blocks[0]?.text).toBe('This sentence continues into the next page.');
    expect(page1?.blocks[0]?.fragments).toHaveLength(2);
    expect(page2?.blocks.map((b) => b.id)).toEqual(['b3']);
  });

  test('does not stitch across section-header boundary', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'paragraph', 'This sentence continues', 1, 0),
      ],
      [
        makeBlock('b2', 'section-header', '2 New Section', 2, 0),
        makeBlock('b3', 'paragraph', 'into the next page.', 2, 1),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    expect(stitched.pages[0]?.blocks[0]?.fragments).toHaveLength(1);
    expect(stitched.pages[1]?.blocks.map((b) => b.id)).toEqual(['b2', 'b3']);
  });

  test('does not stitch when tail has sentence terminal', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'paragraph', 'This sentence is complete.', 1, 0),
      ],
      [
        makeBlock('b2', 'paragraph', 'next sentence starts here', 2, 0),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    expect(stitched.pages[0]?.blocks[0]?.fragments).toHaveLength(1);
    expect(stitched.pages[1]?.blocks.map((b) => b.id)).toEqual(['b2']);
  });
});

