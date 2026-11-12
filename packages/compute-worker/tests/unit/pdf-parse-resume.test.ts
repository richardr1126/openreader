import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ParsedPdfPage } from '../../src/api/types';

// Layout inference and page rasterising are the slow, native parts of a parse
// and say nothing about how completed pages are handed back, so this exercises
// the real page loop over a real PDF with those two stubbed.
vi.mock('../../src/inference/pdf/model', () => ({ ensureModel: async () => 'model' }));
vi.mock('../../src/inference/pdf/layout-model', () => ({
  runLayoutModel: async () => [{
    label: 'text',
    bbox: [0, 0, 612, 792] as [number, number, number, number],
    confidence: 0.9,
  }],
}));
vi.mock('../../src/inference/pdf/render', () => ({
  renderPage: async () => ({ width: 612, height: 792, image: new Uint8Array(4) }),
}));

const { parsePdf } = await import('../../src/inference/pdf/parse');

const pdfBytes = readFileSync(fileURLToPath(new URL('../fixtures/pdf/twenty-pages.pdf', import.meta.url)));

function freshPdfBytes(): ArrayBuffer {
  return pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength,
  ) as ArrayBuffer;
}

describe('resuming a PDF parse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('hands back completed pages in contiguous batches while parsing', async () => {
    const batches: Array<{ startPage: number; pageNumbers: number[] }> = [];

    const parsed = await parsePdf({
      documentId: 'e'.repeat(64),
      pdfBytes: freshPdfBytes(),
      onPagesCompleted: async ({ pages, startPage }) => {
        batches.push({ startPage, pageNumbers: pages.map((page) => page.pageNumber) });
      },
    });

    expect(parsed.pages).toHaveLength(20);
    // Pages arrive in order, each batch continuing where the last one ended.
    expect(batches.map((batch) => batch.startPage)).toEqual([1, 9]);
    expect(batches[0].pageNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(batches[1].pageNumbers).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  }, 60_000);

  test('starts after the pages it is given and leaves them untouched', async () => {
    const firstRun: ParsedPdfPage[] = [];
    await parsePdf({
      documentId: 'e'.repeat(64),
      pdfBytes: freshPdfBytes(),
      onPagesCompleted: async ({ pages }) => { firstRun.push(...pages); },
    });
    expect(firstRun).toHaveLength(16);

    const started: number[] = [];
    const resumed = await parsePdf({
      documentId: 'e'.repeat(64),
      pdfBytes: freshPdfBytes(),
      resume: { pages: firstRun, sawText: true },
      onPageStarted: async ({ pageNumber }) => { started.push(pageNumber); },
    });

    // Only the pages the interrupted run never reached are parsed again.
    expect(started).toEqual([17, 18, 19, 20]);
    expect(resumed.pages).toHaveLength(20);
    expect(resumed.pages.map((page) => page.pageNumber))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  }, 60_000);

  test('keeps block ids in one sequence across a resume', async () => {
    const whole = await parsePdf({ documentId: 'e'.repeat(64), pdfBytes: freshPdfBytes() });

    const firstRun: ParsedPdfPage[] = [];
    await parsePdf({
      documentId: 'e'.repeat(64),
      pdfBytes: freshPdfBytes(),
      onPagesCompleted: async ({ pages }) => { firstRun.push(...pages); },
    });
    const resumed = await parsePdf({
      documentId: 'e'.repeat(64),
      pdfBytes: freshPdfBytes(),
      resume: { pages: firstRun, sawText: true },
    });

    const ids = (document: { pages: ParsedPdfPage[] }) =>
      document.pages.flatMap((page) => page.blocks.map((block) => block.id));
    expect(ids(resumed)).toEqual(ids(whole));
    expect(new Set(ids(resumed)).size).toBe(ids(resumed).length);
  }, 60_000);

  test('ignores a checkpoint that claims more pages than the document has', async () => {
    const started: number[] = [];
    const parsed = await parsePdf({
      documentId: 'e'.repeat(64),
      pdfBytes: freshPdfBytes(),
      resume: {
        pages: Array.from({ length: 50 }, (_, index) => ({
          pageNumber: index + 1, width: 1, height: 1, blocks: [],
        })) as ParsedPdfPage[],
        sawText: true,
      },
      onPageStarted: async ({ pageNumber }) => { started.push(pageNumber); },
    });

    expect(started[0]).toBe(1);
    expect(parsed.pages).toHaveLength(20);
  }, 60_000);
});
