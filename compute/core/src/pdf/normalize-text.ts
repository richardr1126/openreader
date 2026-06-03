import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem } from './types';

interface ViewportLike {
  height: number;
  transform: readonly number[];
}

function applyViewportTransform(
  x: number,
  y: number,
  transform: readonly number[],
): { x: number; y: number } {
  const a = Number(transform[0] ?? 1);
  const b = Number(transform[1] ?? 0);
  const c = Number(transform[2] ?? 0);
  const d = Number(transform[3] ?? 1);
  const e = Number(transform[4] ?? 0);
  const f = Number(transform[5] ?? 0);
  return {
    x: (a * x) + (c * y) + e,
    y: (b * x) + (d * y) + f,
  };
}

export function normalizeTextItemsForLayout(items: TextItem[], viewport: ViewportLike): PdfTextItem[] {
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
      const origin = applyViewportTransform(
        Number(item.transform[4] ?? 0),
        Number(item.transform[5] ?? 0),
        viewport.transform,
      );
      const width = Math.max(0, Number(item.width ?? 0));
      const height = Math.max(1, Math.abs(Number(item.transform[3] ?? 1)));
      // pdf.js text transforms are in PDF user-space and may include non-zero
      // page origins via the viewport transform. Map the text baseline into
      // viewport coordinates first, then convert baseline to top-left.
      const x = Math.max(0, origin.x);
      const y = Math.max(0, origin.y - height);
      return {
        text: item.str,
        x,
        y,
        width,
        height,
      };
    });
}
