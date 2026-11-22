import type { TTSSegmentLocator } from '@/types/client';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

/** The part of a segment's text that one page shows, in segment-text offsets. */
export type PdfSegmentPagePart = {
  page: number;
  start: number;
  end: number;
  text: string;
};

/** The segment text the part offsets index into. */
export const normalizePdfSegmentText = (text: string): string => text.replace(/\s+/g, ' ').trim();
const normalize = normalizePdfSegmentText;

/**
 * Where a segment's text lies on each page, in reading order.
 *
 * A paragraph that runs over a page break is one parsed block whose fragments
 * sit on both pages, so its last sentence starts on one page and ends on the
 * next. Narration follows a segment by its locator page; these parts let the
 * reader turn on the first word spoken on the next page and highlight only the
 * words a rendered page shows. A block on one page, or one whose fragment text
 * cannot be placed in the block text, is a single part on the locator page.
 *
 * `blockOffset` is where the segment starts in the raw block text (the plan
 * segment's start anchor); it picks the right copy of a sentence the block
 * repeats.
 */
export function resolvePdfSegmentPageParts(
  parsedDocument: ParsedPdfDocument | null | undefined,
  locator: TTSSegmentLocator | null | undefined,
  segmentText: string | null | undefined,
  blockOffset?: number,
): PdfSegmentPagePart[] {
  if (!locator || locator.readerType !== 'pdf' || typeof locator.page !== 'number') return [];
  const text = normalize(segmentText ?? '');
  if (!text) return [];
  const whole: PdfSegmentPagePart[] = [{ page: locator.page, start: 0, end: text.length, text }];

  const block = parsedDocument?.pages
    .find((page) => page.pageNumber === locator.page)?.blocks
    .find((candidate) => candidate.id === locator.blockId);
  if (!block || new Set(block.fragments.map((fragment) => fragment.page)).size < 2) return whole;

  // Page start offsets within the block text. Stitching appends each
  // continuation to the block text in fragment order.
  const blockText = normalize(block.text);
  const pageStarts: Array<{ page: number; start: number }> = [];
  let cursor = 0;
  for (const fragment of block.fragments) {
    const fragmentText = normalize(fragment.text ?? '');
    if (!fragmentText) continue;
    const at = blockText.indexOf(fragmentText, cursor);
    if (at < 0) return whole;
    cursor = at + fragmentText.length;
    if (pageStarts.at(-1)?.page !== fragment.page) pageStarts.push({ page: fragment.page, start: at });
  }
  if (pageStarts.length < 2) return whole;

  const segmentStart = findSegmentStart(blockText, text, block.text, blockOffset);
  if (segmentStart < 0) return whole;
  const segmentEnd = segmentStart + text.length;

  const parts: PdfSegmentPagePart[] = [];
  pageStarts.forEach(({ page }, index) => {
    const pageStart = index === 0 ? 0 : pageStarts[index].start;
    const pageEnd = pageStarts[index + 1]?.start ?? blockText.length;
    const start = Math.max(pageStart, segmentStart) - segmentStart;
    const end = Math.min(pageEnd, segmentEnd) - segmentStart;
    if (end <= start) return;
    const partText = text.slice(start, end);
    const lead = partText.length - partText.trimStart().length;
    const trimmed = partText.trim();
    if (!trimmed) return;
    parts.push({ page, start: start + lead, end: start + lead + trimmed.length, text: trimmed });
  });
  return parts.length ? parts : whole;
}

function findSegmentStart(blockText: string, text: string, rawBlockText: string, blockOffset?: number): number {
  const first = blockText.indexOf(text);
  if (first < 0 || typeof blockOffset !== 'number') return first;
  // Normalizing only collapses whitespace, so the raw offset maps to roughly
  // the same place; the nearest copy is the one being spoken.
  const hint = normalize(rawBlockText.slice(0, blockOffset)).length;
  let best = first;
  for (let at = first; at >= 0; at = blockText.indexOf(text, at + 1)) {
    if (Math.abs(at - hint) < Math.abs(best - hint)) best = at;
  }
  return best;
}

/** The page that shows the character at `offset` of the segment text. */
export function pdfSegmentPageAt(parts: readonly PdfSegmentPagePart[], offset: number): number | null {
  let page: number | null = parts[0]?.page ?? null;
  for (const part of parts) {
    if (offset < part.start) break;
    page = part.page;
  }
  return page;
}

/**
 * The spoken words a page shows: the first and last alignment word whose span,
 * in segment-text offsets, starts within the page's part.
 */
export function pdfPartWordRange(
  wordSpans: ReadonlyArray<{ start: number } | null>,
  part: PdfSegmentPagePart,
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  wordSpans.forEach((span, index) => {
    if (!span || span.start < part.start || span.start >= part.end) return;
    if (first < 0) first = index;
    last = index;
  });
  return first < 0 ? null : { first, last };
}
