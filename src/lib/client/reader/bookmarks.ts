import type { CreateDocumentBookmarkInput, DocumentBookmark } from '@/types/bookmarks';
import type { TTSLocation } from '@/types/tts';
import type { ReaderType } from '@/types/user-state';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import { isHtmlLocator, isPdfLocator, isStableEpubLocator } from '@openreader/tts/types';
import { normalizeEpubProgressLocator } from '@/lib/shared/epub-progress';
import { parseReaderInitialPosition, serializeReaderPosition } from '@/lib/shared/reader-position';
import {
  resolveEpubPlanBackedSelection,
  resolveFirstPlanIndexForDocumentAnchor,
} from '@/lib/client/tts/playback-selection';

export const BOOKMARK_SNIPPET_DISPLAY_LENGTH = 200;

export function truncateBookmarkSnippet(text: string, max = BOOKMARK_SNIPPET_DISPLAY_LENGTH): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The create body for bookmarking one plan sentence, positioned with the same
 * encoding reading progress uses. Null when the sentence has no stable
 * position (an EPUB segment without a stable spine locator).
 */
export function bookmarkInputForSegment(input: {
  readerType: ReaderType;
  segment: CanonicalTtsSegment;
  /** The reader's current page/location, used when the segment carries none. */
  currentLocation: TTSLocation;
  id: string;
}): CreateDocumentBookmarkInput | null {
  const { readerType, segment, currentLocation, id } = input;
  const base = {
    id,
    snippet: truncateBookmarkSnippet(segment.text),
    segmentKey: segment.key,
    segmentOrdinal: segment.ordinal,
  };
  const locator = segment.ownerLocator;
  if (readerType === 'epub') {
    if (!isStableEpubLocator(locator)) return null;
    return {
      ...base,
      readerType: 'epub',
      locator: {
        schemaVersion: 1,
        spineHref: locator.spineHref,
        spineIndex: Math.max(0, Math.floor(locator.spineIndex)),
        charOffset: Math.max(0, Math.floor(locator.charOffset)),
      },
    };
  }
  if (readerType === 'pdf') {
    const page = isPdfLocator(locator) ? locator.page : currentLocation;
    return { ...base, readerType: 'pdf', location: serializeReaderPosition('pdf', page, segment.ordinal) };
  }
  const location = isHtmlLocator(locator) ? locator.location : currentLocation;
  return { ...base, readerType: 'html', location: serializeReaderPosition('html', location, segment.ordinal) };
}

/** The bookmark on this plan sentence, matching by content key before ordinal. */
export function findBookmarkForSegment(
  bookmarks: readonly DocumentBookmark[],
  segment: Pick<CanonicalTtsSegment, 'key' | 'ordinal'> | null | undefined,
): DocumentBookmark | null {
  if (!segment) return null;
  return bookmarks.find((bookmark) => (
    bookmark.segmentKey
      ? bookmark.segmentKey === segment.key
      : bookmark.segmentOrdinal === segment.ordinal
  )) ?? null;
}

/**
 * The plan ordinal a bookmark seeks to. The content key survives re-planning,
 * so it wins; the stored ordinal is used while it still exists in the plan;
 * otherwise the stored reader position resolves to the first sentence there.
 */
export function resolveBookmarkOrdinal(
  bookmark: DocumentBookmark,
  plan: CanonicalTtsSegment[],
): number | null {
  if (plan.length === 0) return null;
  if (bookmark.segmentKey) {
    const byKey = plan.find((segment) => segment.key === bookmark.segmentKey);
    if (byKey) return byKey.ordinal;
  }
  if (bookmark.segmentOrdinal !== null && plan.some((segment) => segment.ordinal === bookmark.segmentOrdinal)) {
    return bookmark.segmentOrdinal;
  }

  if (bookmark.readerType === 'epub') {
    const locator = normalizeEpubProgressLocator(bookmark.locator);
    if (!locator) return null;
    const resolution = resolveEpubPlanBackedSelection({
      plan,
      locator: { readerType: 'epub', ...locator },
    });
    return resolution.status === 'selected' ? resolution.ordinal : null;
  }

  const position = parseReaderInitialPosition(bookmark.readerType, {
    documentId: bookmark.documentId,
    readerType: bookmark.readerType,
    location: bookmark.location,
    progress: null,
    clientUpdatedAtMs: 0,
    updatedAtMs: 0,
  });
  if (!position || position.readerType === 'epub') return null;
  const index = resolveFirstPlanIndexForDocumentAnchor(plan, bookmark.readerType, position.location);
  return index >= 0 ? plan[index].ordinal : null;
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
