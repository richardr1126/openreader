import { isHighlight, type CreateDocumentBookmarkInput, type DocumentBookmark } from '@/types/bookmarks';
import { resolveReadingPositionOrdinal } from '@/lib/shared/reading-position';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

export const BOOKMARK_SNIPPET_DISPLAY_LENGTH = 200;

export function truncateBookmarkSnippet(text: string, max = BOOKMARK_SNIPPET_DISPLAY_LENGTH): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** The create body for bookmarking one plan sentence. */
export function bookmarkInputForSegment(input: {
  segment: CanonicalTtsSegment;
  id: string;
}): CreateDocumentBookmarkInput {
  const { segment, id } = input;
  return {
    id,
    segmentKey: segment.key,
    segmentOrdinal: segment.ordinal,
    snippet: truncateBookmarkSnippet(segment.text),
  };
}

/** The bookmark (never a highlight) on this plan sentence, matched by content key. */
export function findBookmarkForSegment(
  bookmarks: readonly DocumentBookmark[],
  segment: Pick<CanonicalTtsSegment, 'key'> | null | undefined,
): DocumentBookmark | null {
  if (!segment) return null;
  return bookmarks.find((bookmark) => !isHighlight(bookmark) && bookmark.segmentKey === segment.key) ?? null;
}

type PlanSegment = Pick<CanonicalTtsSegment, 'key' | 'ordinal' | 'text'>;

/** The create body for highlighting the sentences from `start` through `end`. */
export function highlightInputForSegments(input: {
  start: CanonicalTtsSegment;
  end: CanonicalTtsSegment;
  id: string;
}): CreateDocumentBookmarkInput {
  const [start, end] = input.start.ordinal <= input.end.ordinal
    ? [input.start, input.end]
    : [input.end, input.start];
  return {
    id: input.id,
    segmentKey: start.key,
    segmentOrdinal: start.ordinal,
    endSegmentKey: end.key,
    endSegmentOrdinal: end.ordinal,
    snippet: truncateBookmarkSnippet(start.text),
  };
}

/** A highlight placed in the current plan: its first and last sentence ordinals. */
export type ResolvedHighlight = {
  highlight: DocumentBookmark;
  start: number;
  end: number;
};

/**
 * Place each highlight in the plan, resolving both ends the way reading
 * progress resolves, in reading order. A highlight whose ends no longer
 * resolve is left out rather than painted somewhere it was not.
 */
export function resolveHighlights(
  plan: readonly PlanSegment[],
  bookmarks: readonly DocumentBookmark[],
): ResolvedHighlight[] {
  const resolved: ResolvedHighlight[] = [];
  for (const highlight of bookmarks) {
    if (!isHighlight(highlight)) continue;
    const start = resolveReadingPositionOrdinal(plan, highlight);
    const end = resolveReadingPositionOrdinal(plan, {
      segmentKey: highlight.endSegmentKey,
      segmentOrdinal: highlight.endSegmentOrdinal ?? highlight.segmentOrdinal,
    });
    if (start === null || end === null) continue;
    resolved.push({ highlight, start: Math.min(start, end), end: Math.max(start, end) });
  }
  return resolved.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The highlights covering any sentence in `[from, to]`. */
export function highlightsOverlapping(
  highlights: readonly ResolvedHighlight[],
  from: number,
  to: number,
): ResolvedHighlight[] {
  return highlights.filter((entry) => entry.start <= to && entry.end >= from);
}

/**
 * The highlight `[from, to]` makes once joined with every highlight it
 * touches, including ones reached only through another, and the labels those
 * carried, distinct and in reading order.
 */
export function mergeHighlightRange(
  highlights: readonly ResolvedHighlight[],
  from: number,
  to: number,
): { start: number; end: number; absorbed: ResolvedHighlight[]; label: string | null } {
  let start = Math.min(from, to);
  let end = Math.max(from, to);
  let absorbed: ResolvedHighlight[] = [];
  for (;;) {
    absorbed = highlightsOverlapping(highlights, start, end);
    const nextStart = Math.min(start, ...absorbed.map((entry) => entry.start));
    const nextEnd = Math.max(end, ...absorbed.map((entry) => entry.end));
    if (nextStart === start && nextEnd === end) break;
    start = nextStart;
    end = nextEnd;
  }
  const labels = [...new Set(absorbed.map((entry) => entry.highlight.label?.trim()).filter((label): label is string => Boolean(label)))];
  return { start, end, absorbed, label: labels.length > 0 ? labels.join('\n').slice(0, 200) : null };
}

/** The full text of a highlight's sentences, joined as they are read. */
export function highlightText(plan: readonly PlanSegment[], entry: Pick<ResolvedHighlight, 'start' | 'end'>): string {
  return plan
    .filter((segment) => segment.ordinal >= entry.start && segment.ordinal <= entry.end)
    .map((segment) => segment.text.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

/** Every highlight as a Markdown quote, in reading order, under the document title. */
export function highlightsToMarkdown(
  title: string,
  plan: readonly PlanSegment[],
  highlights: readonly ResolvedHighlight[],
): string {
  const blocks = highlights.map((entry) => {
    const quote = `> ${highlightText(plan, entry)}`;
    const label = entry.highlight.label?.trim();
    return label ? `${quote}\n\n${label}` : quote;
  });
  return [`# ${title.trim() || 'Highlights'}`, ...blocks].join('\n\n') + '\n';
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function formatBookmarkAge(createdAtMs: number, nowMs: number, locale?: string): string {
  const elapsed = Math.max(0, nowMs - createdAtMs);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (elapsed >= unitMs) return format.format(-Math.floor(elapsed / unitMs), unit);
  }
  return 'just now';
}
