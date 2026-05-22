import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem } from './types';

export function normalizeTextItemsForLayout(items: TextItem[], pageHeight: number): PdfTextItem[] {
  return items
    .filter((item) => {
      if (!(typeof item.str === 'string' && item.str.trim().length > 0)) return false;
      const transform = item.transform;
      if (!Array.isArray(transform) || transform.length < 6) return false;

      // Reject heavily skewed/rotated text runs (e.g. vertical margin labels
      // such as arXiv metadata) so they do not get merged into body blocks.
      const skewX = Number(transform[1] ?? 0);
      const skewY = Number(transform[2] ?? 0);
      if (Math.abs(skewX) > 0.5 || Math.abs(skewY) > 0.5) return false;

      return true;
    })
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
