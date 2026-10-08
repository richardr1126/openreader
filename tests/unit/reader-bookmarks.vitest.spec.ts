import { describe, expect, test } from 'vitest';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TTSSegmentLocator } from '@openreader/tts/types';
import {
  bookmarkInputForSegment,
  findBookmarkForSegment,
  formatBookmarkAge,
  truncateBookmarkSnippet,
} from '@/lib/client/reader/bookmarks';
import type { DocumentBookmark } from '@/types/bookmarks';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function segment(ordinal: number, locator: TTSSegmentLocator | null, text = `Sentence ${ordinal}.`): CanonicalTtsSegment {
  return {
    key: `key-${ordinal}`,
    ordinal,
    text,
    ownerSourceKey: `source-${ordinal}`,
    ownerLocator: locator,
    startAnchor: { sourceKey: `source-${ordinal}`, offset: 0 },
    endAnchor: { sourceKey: `source-${ordinal}`, offset: text.length },
    spansSourceBoundary: false,
  };
}

function bookmark(overrides: Partial<DocumentBookmark>): DocumentBookmark {
  return {
    id: ID,
    documentId: 'doc',
    label: null,
    snippet: 'snippet',
    segmentKey: 'key-0',
    segmentOrdinal: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

const pdfPlan = [
  segment(0, { readerType: 'pdf', page: 1 }),
  segment(1, { readerType: 'pdf', page: 1 }),
  segment(2, { readerType: 'pdf', page: 2 }),
  segment(3, { readerType: 'pdf', page: 3 }),
];

describe('bookmarkInputForSegment', () => {
  test('positions a sentence by its plan key and ordinal for every reader type', () => {
    expect(bookmarkInputForSegment({ segment: pdfPlan[2], id: ID })).toEqual({
      id: ID,
      segmentKey: 'key-2',
      segmentOrdinal: 2,
      snippet: 'Sentence 2.',
    });
    // No page, block or spine locator is needed: those are derived views.
    expect(bookmarkInputForSegment({ segment: segment(9, null), id: ID }))
      .toMatchObject({ segmentKey: 'key-9', segmentOrdinal: 9 });
  });

  test('collapses and truncates a long sentence for the snippet', () => {
    const long = `${'word '.repeat(80)}end`;
    const snippet = truncateBookmarkSnippet(long, 20);
    expect(snippet).toHaveLength(20);
    expect(snippet.endsWith('…')).toBe(true);
    expect(truncateBookmarkSnippet('  a \n b  ')).toBe('a b');
  });
});

describe('findBookmarkForSegment', () => {
  test('matches by content key, not by a reused ordinal', () => {
    const marked = bookmark({ id: 'k', segmentKey: 'key-1', segmentOrdinal: 7 });
    expect(findBookmarkForSegment([marked], pdfPlan[1])?.id).toBe('k');
    expect(findBookmarkForSegment([marked], segment(7, null))).toBeNull();
    expect(findBookmarkForSegment([marked], null)).toBeNull();
  });
});

describe('formatBookmarkAge', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  test('describes recent and older bookmarks', () => {
    expect(formatBookmarkAge(now - 10_000, now, 'en')).toBe('just now');
    expect(formatBookmarkAge(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(formatBookmarkAge(now - 86_400_000, now, 'en')).toBe('yesterday');
    expect(formatBookmarkAge(now - 15 * 86_400_000, now, 'en')).toBe('2 weeks ago');
    expect(formatBookmarkAge(now + 60_000, now, 'en')).toBe('just now');
  });
});
