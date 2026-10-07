import type { CreateDocumentBookmarkInput, DocumentBookmark } from '@/types/bookmarks';
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

/** The bookmark on this plan sentence, matched by content key. */
export function findBookmarkForSegment(
  bookmarks: readonly DocumentBookmark[],
  segment: Pick<CanonicalTtsSegment, 'key'> | null | undefined,
): DocumentBookmark | null {
  if (!segment) return null;
  return bookmarks.find((bookmark) => bookmark.segmentKey === segment.key) ?? null;
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
