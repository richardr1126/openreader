import path from 'path';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { ParsedPdfDocument, ParsedPdfPage } from '../types/parsed-pdf';
import { ensureModel } from './model';
import { runLayoutModel } from './runLayoutModel';
import { mergeTextWithRegions } from './merge';
import { stitchCrossPageBlocks } from './stitch';
import { renderPage } from './render';
import { normalizeTextItemsForLayout } from './normalize-text';

interface ParsePdfInput {
  documentId: string;
  pdfBytes: ArrayBuffer;
  onPageParsed?: (input: {
    pageNumber: number;
    totalPages: number;
    pageMs: number;
  }) => void | Promise<void>;
}

const LAYOUT_RENDER_SCALE = 1.5;

function resolvePdfjsStandardFontDataUrl(): string {
  const standardFontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
  return `${standardFontDir.replace(/\/?$/, '/')}`;
}

export async function parsePdf(input: ParsePdfInput): Promise<ParsedPdfDocument> {
  await ensureModel();

  // Keep independent byte copies for text extraction and page rendering. pdf.js
  // can detach buffers passed to getDocument().
  const pdfBytesForText = new Uint8Array(input.pdfBytes).slice();
  const pdfBytesForRender = new Uint8Array(input.pdfBytes).slice();

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }
  const standardFontDataUrl = resolvePdfjsStandardFontDataUrl();

  const loadingTask = pdfjs.getDocument({
    data: pdfBytesForText,
    useWorkerFetch: false,
    standardFontDataUrl,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  try {
    const pages: ParsedPdfPage[] = [];
    let nextBlockId = 1;
    let sawText = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const pageStartedAt = Date.now();
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      const textItems = normalizeTextItemsForLayout(
        textContent.items.filter((item): item is TextItem => 'str' in item && 'transform' in item),
        viewport.height,
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
      if (textItems.length > 0 && merged.length === 0) {
        throw new Error(`layout-merge-empty: page=${pageNumber} regions=${regions.length}`);
      }

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
    }

    if (!sawText) {
      throw new Error('no-text-layer');
    }

    const doc: ParsedPdfDocument = {
      schemaVersion: 1,
      documentId: input.documentId,
      parserVersion: 'pp-doclayoutv3-onnx@800+pdfjs@4.8.69',
      parsedAt: Date.now(),
      pages,
    };

    return stitchCrossPageBlocks(doc);
  } finally {
    await pdf.destroy().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
  }
}
