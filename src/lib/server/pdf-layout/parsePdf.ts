import path from 'path';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { ParsedPdfDocument, ParsedPdfPage } from '@/types/parsed-pdf';
import type { PdfTextItem } from '@/lib/server/pdf-layout/types';
import { ensureModel } from '@/lib/server/pdf-layout/ensureModel';
import { runLayoutModel } from '@/lib/server/pdf-layout/runLayoutModel';
import { mergeTextWithRegions } from '@/lib/server/pdf-layout/mergeTextWithRegions';
import { stitchCrossPageBlocks } from '@/lib/server/pdf-layout/stitchCrossPageBlocks';
import { renderPage } from '@/lib/server/pdf-layout/renderPage';

interface ParsePdfInput {
  documentId: string;
  pdfBytes: ArrayBuffer;
}

const LAYOUT_RENDER_SCALE = 1.5;

function normalizeTextItems(items: TextItem[], pageHeight: number): PdfTextItem[] {
  return items
    .filter((item) => typeof item.str === 'string' && item.str.trim().length > 0)
    .map((item) => {
      const x = Number(item.transform[4] ?? 0);
      const width = Math.max(0, Number(item.width ?? 0));
      const height = Math.max(1, Math.abs(Number(item.transform[3] ?? 1)));
      const baselineY = Number(item.transform[5] ?? 0);
      // pdf.js text transforms are in PDF user-space (origin bottom-left).
      // Normalize into top-left page coordinates to match rendered image/model boxes.
      const y = Math.max(0, pageHeight - baselineY - height);
      return {
        text: item.str,
        x,
        y,
        width,
        height,
      };
    });
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
  const standardFontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
  const standardFontDataUrl = `${standardFontDir.replace(/\/?$/, '/')}`;

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
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      const textItems = normalizeTextItems(
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
        pagePng: rendered.png,
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
