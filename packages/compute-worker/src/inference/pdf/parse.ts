import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { ParsedPdfDocument, ParsedPdfPage } from '../../api/types';
import { ensureModel } from './model';
import { runLayoutModel } from './layout-model';
import { mergeTextWithRegions } from './document-layout';
import { configurePdfjsNodeRuntime, resolvePdfjsStandardFontDataUrl } from './pdfjs';
import { PDF_PARSER_VERSION } from '../../operations/contracts';
import { stitchCrossPageBlocks } from './stitch';
import { renderPage } from './render';
import { normalizeTextItemsForLayout } from './normalize-text';
import type { ModelDownloadProgressHandler } from '../model-download';

interface ParsePdfInput {
  documentId: string;
  pdfBytes: ArrayBuffer;
  onPageStarted?: (input: {
    pageNumber: number;
    totalPages: number;
  }) => void | Promise<void>;
  onPageParsed?: (input: {
    pageNumber: number;
    totalPages: number;
    pageMs: number;
  }) => void | Promise<void>;
  onModelDownloadProgress?: ModelDownloadProgressHandler;
  /** Pages an earlier run already parsed, covering 1..pages.length. */
  resume?: { pages: ParsedPdfPage[]; sawText: boolean } | null;
  /** Hands back whole pages as they finish, so a caller can make them durable. */
  onPagesCompleted?: (input: {
    pages: ParsedPdfPage[];
    startPage: number;
    totalPages: number;
    sawText: boolean;
  }) => void | Promise<void>;
}

const LAYOUT_RENDER_SCALE = 1.5;

/**
 * Pages per handback. Small enough that an interrupted parse loses seconds of
 * work rather than minutes, large enough not to put a write between every page.
 */
const COMPLETED_PAGE_BATCH = 8;

/** Block ids run in one sequence across a document and must keep doing so. */
function nextBlockIdAfter(pages: ParsedPdfPage[]): number {
  let highest = 0;
  for (const page of pages) {
    for (const block of page.blocks) {
      const id = Number(block.id.slice(1));
      if (Number.isFinite(id) && id > highest) highest = id;
    }
  }
  return highest + 1;
}

export async function parsePdf(input: ParsePdfInput): Promise<ParsedPdfDocument> {
  await ensureModel({ onProgress: input.onModelDownloadProgress });

  // Keep independent byte copies for text extraction and page rendering. pdf.js
  // can detach buffers passed to getDocument().
  const pdfBytesForText = new Uint8Array(input.pdfBytes).slice();
  const pdfBytesForRender = new Uint8Array(input.pdfBytes).slice();

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  configurePdfjsNodeRuntime(pdfjs);
  const standardFontDataUrl = resolvePdfjsStandardFontDataUrl();

  const loadingTask = pdfjs.getDocument({
    data: pdfBytesForText,
    useWorkerFetch: false,
    standardFontDataUrl,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  try {
    // A checkpoint from a different document would be caught before it got
    // here, but one that claims more pages than this PDF has is not usable.
    const resumed = input.resume && input.resume.pages.length <= pdf.numPages ? input.resume : null;
    const pages: ParsedPdfPage[] = [...(resumed?.pages ?? [])];
    let nextBlockId = nextBlockIdAfter(pages);
    let sawText = resumed?.sawText ?? false;
    let uncompleted = 0;

    for (let pageNumber = pages.length + 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const pageStartedAt = Date.now();
      if (input.onPageStarted) {
        await input.onPageStarted({
          pageNumber,
          totalPages: pdf.numPages,
        });
      }
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      const textItems = normalizeTextItemsForLayout(
        textContent.items.filter((item): item is TextItem => 'str' in item && 'transform' in item),
        viewport,
        textContent.styles,
      );

      if (textItems.length > 0) sawText = true;

      const rendered = await renderPage({
        pdfBytes: pdfBytesForRender.buffer.slice(
          pdfBytesForRender.byteOffset,
          pdfBytesForRender.byteOffset + pdfBytesForRender.byteLength,
        ),
        pageNumber,
        scale: LAYOUT_RENDER_SCALE,
      });
      const scaleX = rendered.width / Math.max(1, viewport.width);
      const scaleY = rendered.height / Math.max(1, viewport.height);
      const layoutTextItems = textItems.map((item) => ({
        ...item,
        x: item.x * scaleX,
        y: item.y * scaleY,
        width: item.width * scaleX,
        height: item.height * scaleY,
      }));
      const regions = await runLayoutModel({
        pageWidth: rendered.width,
        pageHeight: rendered.height,
        textItems: layoutTextItems,
        pageImage: rendered.image,
      });
      const merged = mergeTextWithRegions(regions, layoutTextItems);
      // Do not fail the full document parse when a page has text but model
      // detection/assignment yields no merged regions. Emit an empty page so
      // downstream playback/tts flows can naturally skip it.

      const blocks = merged
        .map((entry, readingOrder) => ({
          id: `b${String(nextBlockId++).padStart(4, '0')}`,
          kind: entry.region.label,
          fragments: [{
            page: pageNumber,
            bbox: [
              entry.region.bbox[0] / scaleX,
              entry.region.bbox[1] / scaleY,
              entry.region.bbox[2] / scaleX,
              entry.region.bbox[3] / scaleY,
            ] as [number, number, number, number],
            text: entry.text,
            readingOrder,
            ...(typeof entry.region.confidence === 'number' ? { modelConfidence: entry.region.confidence } : {}),
          }],
          text: entry.text,
        }));

      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        blocks,
      });

      if (input.onPageParsed) {
        await input.onPageParsed({
          pageNumber,
          totalPages: pdf.numPages,
          pageMs: Date.now() - pageStartedAt,
        });
      }

      uncompleted += 1;
      if (input.onPagesCompleted && uncompleted >= COMPLETED_PAGE_BATCH) {
        await input.onPagesCompleted({
          pages: pages.slice(pages.length - uncompleted),
          startPage: pages.length - uncompleted + 1,
          totalPages: pdf.numPages,
          sawText,
        });
        uncompleted = 0;
      }
    }

    if (!sawText) {
      throw new Error('no-text-layer');
    }

    const doc: ParsedPdfDocument = {
      schemaVersion: 1,
      documentId: input.documentId,
      parserVersion: PDF_PARSER_VERSION,
      parsedAt: Date.now(),
      pages,
    };

    return stitchCrossPageBlocks(doc);
  } finally {
    await pdf.destroy().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
  }
}
