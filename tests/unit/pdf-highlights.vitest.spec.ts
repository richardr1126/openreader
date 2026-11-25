import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  clearHighlights,
  clearWordHighlights,
  highlightPattern,
  highlightWordIndex,
} from '../../src/lib/client/pdf';
import type { ParsedPdfDocument } from '../../src/types/parsed-pdf';
import type { TTSSentenceAlignment } from '../../src/types/tts';

const sentence = 'Alpha beta.';
const locator = { readerType: 'pdf' as const, page: 1, blockId: 'block' };
const parsedDocument: ParsedPdfDocument = {
  schemaVersion: 1,
  documentId: 'document',
  parserVersion: 'test',
  parsedAt: 0,
  pages: [{
    pageNumber: 1,
    width: 200,
    height: 200,
    blocks: [{
      id: 'block',
      kind: 'text',
      text: sentence,
      fragments: [{ page: 1, bbox: [0, 0, 150, 30], text: sentence, readingOrder: 0 }],
    }],
  }],
};
const alignment: TTSSentenceAlignment = {
  sentenceIndex: 0,
  sentence,
  words: [
    { text: 'Alpha', startSec: 0, endSec: 0.5 },
    { text: 'beta', startSec: 0.5, endSec: 1 },
  ],
};

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

function createSurface() {
  const { document, window } = parseHTML(`<html><body><div id="reader"><div class="react-pdf__Page" data-page-number="1"><div class="react-pdf__Page__textContent"><span>${sentence}</span></div></div></div></body></html>`);
  vi.stubGlobal('document', document);
  vi.stubGlobal('Node', window.Node);
  const container = document.querySelector('#reader') as HTMLDivElement;
  const page = container.querySelector('.react-pdf__Page') as HTMLDivElement;
  const span = container.querySelector('span') as HTMLSpanElement;
  container.getBoundingClientRect = () => rect(0, 0, 200, 200);
  Object.assign(container, { clientWidth: 200, clientHeight: 200, clientLeft: 0, clientTop: 0 });
  container.scrollTo = vi.fn(({ top, left }) => {
    container.scrollTop = Math.max(0, top);
    container.scrollLeft = Math.max(0, left);
  });
  container.scrollTop = 0;
  container.scrollLeft = 0;
  page.getBoundingClientRect = () => rect(0, 0, 200, 200);
  span.getBoundingClientRect = () => rect(10, 10, sentence.length * 5, 10);
  // linkedom does not implement positioned ranges. Derive their geometry from
  // character offsets so assertions also verify the timed word's selected text.
  Object.assign(document, {
    createRange: () => {
      let start = 0;
      let end = 0;
      return {
        setStart: (_node: Text, offset: number) => { start = offset; },
        setEnd: (_node: Text, offset: number) => { end = offset; },
        getClientRects: () => {
          const bounds = span.getBoundingClientRect();
          return [rect(bounds.left + start * 5, bounds.top, (end - start) * 5, bounds.height)];
        },
      };
    },
  });
  return { container, span, ref: { current: container } };
}

describe('independent PDF segment and word highlights', () => {
  let surface: ReturnType<typeof createSurface>;

  beforeEach(() => { surface = createSurface(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('preserves the default segment background and timed word overlay', () => {
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator })).toBe(true);
    highlightWordIndex(alignment, 1, sentence, surface.ref);
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(1);
    const word = surface.container.querySelector('.pdf-word-highlight-overlay') as HTMLElement;
    expect(word.style.left).toBe('40px');
    expect(word.style.width).toBe('20px');
  });

  test('follows a timed word as it becomes clipped, without scrolling again while it fits', () => {
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, follow: false })).toBe(true);
    highlightWordIndex(alignment, 0, sentence, surface.ref, { follow: true });
    expect(surface.container.scrollTo).not.toHaveBeenCalled();

    // A tall zoomed page has room to scroll while the word is only partly visible.
    surface.span.getBoundingClientRect = () => rect(10, 195 - surface.container.scrollTop, 55, 10);
    highlightWordIndex(alignment, 1, sentence, surface.ref, { follow: true });
    expect(surface.container.scrollTop).toBeGreaterThan(0);
    expect(surface.container.scrollTo).toHaveBeenCalledTimes(1);
    highlightWordIndex(alignment, 1, sentence, surface.ref, { follow: true });
    expect(surface.container.scrollTo).toHaveBeenCalledTimes(1);
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(1);
  });

  test('keeps painting offscreen words while browsing and follows again without requiring word paint', () => {
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, useBlockGeometryOnly: true, follow: false })).toBe(true);
    surface.span.getBoundingClientRect = () => rect(10, 280 - surface.container.scrollTop, 55, 10);
    highlightWordIndex(alignment, 1, sentence, surface.ref, { follow: false });
    expect(surface.container.scrollTo).not.toHaveBeenCalled();
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(1);
    highlightWordIndex(alignment, 1, sentence, surface.ref, { follow: true, paintWord: false });
    expect(surface.container.scrollTop).toBeGreaterThan(0);
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(0);
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(1);
  });

  test('pans to a word on an overwide spread without changing the vertical position', () => {
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, follow: false })).toBe(true);
    surface.container.scrollTop = 42;
    surface.span.getBoundingClientRect = () => rect(250 - surface.container.scrollLeft, 20, 55, 10);
    highlightWordIndex(alignment, 0, sentence, surface.ref, { follow: true });
    expect(surface.container.scrollLeft).toBe(75);
    expect(surface.container.scrollTop).toBe(42);
  });

  test('follows the active page of a stitched block when word geometry is unavailable', () => {
    surface.span.remove();
    const rightPage = document.createElement('div');
    rightPage.className = 'react-pdf__Page';
    rightPage.dataset.pageNumber = '2';
    rightPage.getBoundingClientRect = () => rect(220, 0, 200, 200);
    surface.container.appendChild(rightPage);
    const left = parsedDocument.pages[0];
    const block = left.blocks[0];
    const spread = {
      ...parsedDocument,
      pages: [
        { ...left, blocks: [{ ...block, fragments: [...block.fragments, { ...block.fragments[0], page: 2 }] }] },
        { ...left, pageNumber: 2, blocks: [] },
      ],
    };
    expect(highlightPattern(sentence, surface.ref, {
      parsedDocument: spread,
      locator: { ...locator, page: 2 },
      useBlockGeometryOnly: true,
      preferWord: true,
    })).toBe(true);
    expect(surface.container.scrollLeft).toBe(170);
  });

  test('prepares word mapping without painting the segment or replacing text nodes', () => {
    const textNode = surface.span.firstChild;
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, paintSegment: false })).toBe(true);
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(0);
    highlightWordIndex(alignment, 0, sentence, surface.ref);
    const word = surface.container.querySelector('.pdf-word-highlight-overlay') as HTMLElement;
    expect(word.style.left).toBe('10px');
    expect(word.style.width).toBe('25px');
    expect(surface.span.firstChild).toBe(textNode);
  });

  test('keeps segment-only parsed geometry and clears each overlay at its existing boundary', () => {
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, useBlockGeometryOnly: true })).toBe(true);
    const segment = surface.container.querySelector('.pdf-text-highlight-overlay') as HTMLElement;
    expect(segment.style.width).toBe('150px');
    expect(segment.style.height).toBe('30px');
    highlightWordIndex(alignment, 0, sentence, surface.ref);
    clearWordHighlights();
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(0);
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(1);
    clearHighlights();
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(0);
  });

  test('reprepares words when segment paint is disabled and rejects stale mapping after a failed seek', () => {
    highlightPattern(sentence, surface.ref, { parsedDocument, locator });
    highlightWordIndex(alignment, 0, sentence, surface.ref);
    highlightPattern(sentence, surface.ref, { parsedDocument, locator, paintSegment: false });
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(0);
    highlightWordIndex(alignment, 1, sentence, surface.ref);
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(1);

    expect(highlightPattern('', surface.ref, { parsedDocument, locator, paintSegment: false })).toBe(false);
    highlightWordIndex(alignment, 0, sentence, surface.ref);
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(0);
  });

  test('requires rendered text geometry before committing word-only preparation', () => {
    Object.assign(document, {
      createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }),
    });
    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, paintSegment: false })).toBe(false);
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(0);
  });

  test('rebinds word ranges to the replacement text layer after reflow', () => {
    highlightPattern(sentence, surface.ref, { parsedDocument, locator, paintSegment: false });
    const replacement = document.createElement('span');
    replacement.textContent = sentence;
    replacement.getBoundingClientRect = surface.span.getBoundingClientRect;
    surface.span.replaceWith(replacement);
    const starts: Node[] = [];
    Object.assign(document, {
      createRange: () => ({
        setStart: (node: Node) => { starts.push(node); },
        setEnd() {},
        getClientRects: () => [rect(20, 20, 50, 10)],
      }),
    });

    expect(highlightPattern(sentence, surface.ref, { parsedDocument, locator, paintSegment: false })).toBe(true);
    highlightWordIndex(alignment, 1, sentence, surface.ref);
    expect(starts).toEqual([replacement.firstChild, replacement.firstChild]);
    expect(surface.container.querySelectorAll('.pdf-text-highlight-overlay')).toHaveLength(0);
    expect(surface.container.querySelectorAll('.pdf-word-highlight-overlay')).toHaveLength(1);
  });
});
