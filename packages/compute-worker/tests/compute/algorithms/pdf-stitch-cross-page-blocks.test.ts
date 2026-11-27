import { describe, expect, test } from 'vitest';
import { stitchCrossPageBlocks } from '../../../src/inference/pdf/stitch';
import type { ParsedPdfBlock, ParsedPdfDocument, ParsedPdfBlockKind } from '../../../src/api/types';
import { makeParsedPdfDocument, makeParsedPdfPage } from './support/document-fixtures';

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
  return makeParsedPdfDocument([
    makeParsedPdfPage(1, page1Blocks),
    makeParsedPdfPage(2, page2Blocks),
  ]);
}

describe('stitchCrossPageBlocks', () => {
  test('stitches paragraph continuation across footer/header noise', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'text', 'This sentence continues', 1, 0),
        makeBlock('b2', 'footer', 'Footer text', 1, 1),
      ],
      [
        makeBlock('b3', 'header', 'Header text', 2, 0),
        makeBlock('b4', 'text', 'into the next page.', 2, 1),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    const page1 = stitched.pages[0];
    const page2 = stitched.pages[1];

    expect(page1?.blocks[0]?.text).toBe('This sentence continues into the next page.');
    expect(page1?.blocks[0]?.fragments).toHaveLength(2);
    expect(page2?.blocks.map((b) => b.id)).toEqual(['b3']);
  });

  test('moves only the continuation sentence and keeps remaining text on next page', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'text', 'This sentence continues', 1, 0),
      ],
      [
        makeBlock('b2', 'text', 'into the next page. This should stay on page two.', 2, 0),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    const page1 = stitched.pages[0];
    const page2 = stitched.pages[1];

    expect(page1?.blocks[0]?.text).toBe('This sentence continues into the next page.');
    expect(page1?.blocks[0]?.fragments).toHaveLength(2);
    expect(page2?.blocks).toHaveLength(1);
    expect(page2?.blocks[0]?.id).toBe('b2');
    expect(page2?.blocks[0]?.text).toBe('This should stay on page two.');
  });

  test('does not stitch across paragraph-title boundary', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'text', 'This sentence continues', 1, 0),
      ],
      [
        makeBlock('b2', 'paragraph_title', '2 New Section', 2, 0),
        makeBlock('b3', 'text', 'into the next page.', 2, 1),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    expect(stitched.pages[0]?.blocks[0]?.fragments).toHaveLength(1);
    expect(stitched.pages[1]?.blocks.map((b) => b.id)).toEqual(['b2', 'b3']);
  });

  test('does not stitch when tail has sentence terminal', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'text', 'This sentence is complete.', 1, 0),
      ],
      [
        makeBlock('b2', 'text', 'next sentence starts here', 2, 0),
      ],
    );

    const stitched = stitchCrossPageBlocks(doc);
    expect(stitched.pages[0]?.blocks[0]?.fragments).toHaveLength(1);
    expect(stitched.pages[1]?.blocks.map((b) => b.id)).toEqual(['b2']);
  });

  test('keeps text on its own side of a graphic block that has text', () => {
    const tableBetween = makeDoc(
      [
        makeBlock('b1', 'text', 'Before testing, use the following settings:', 1, 0),
        makeBlock('b2', 'table', 'Station Alder Pressure 40 psi', 1, 1),
      ],
      [makeBlock('b3', 'text', '24 hours later, repeat the test at all three stations.', 2, 0)],
    );
    const chartFirst = makeDoc(
      [makeBlock('b1', 'text', 'This sentence continues', 1, 0)],
      [
        makeBlock('b2', 'chart', 'April readings', 2, 0),
        makeBlock('b3', 'text', 'into the next page.', 2, 1),
      ],
    );

    for (const doc of [tableBetween, chartFirst]) {
      const stitched = stitchCrossPageBlocks(doc);
      expect(stitched.pages.flatMap((page) => page.blocks.map((block) => block.text)))
        .toEqual(doc.pages.flatMap((page) => page.blocks.map((block) => block.text)));
    }
  });

  test('still stitches across an empty graphic block', () => {
    const doc = makeDoc(
      [
        makeBlock('b1', 'text', 'This sentence continues', 1, 0),
        makeBlock('b2', 'image', '', 1, 1),
      ],
      [makeBlock('b3', 'text', 'into the next page.', 2, 0)],
    );

    const stitched = stitchCrossPageBlocks(doc);
    expect(stitched.pages[0]?.blocks[0]?.text).toBe('This sentence continues into the next page.');
    expect(stitched.pages[1]?.blocks).toHaveLength(0);
  });
});
