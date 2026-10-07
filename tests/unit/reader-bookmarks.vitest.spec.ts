import { describe, expect, test } from 'vitest';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TTSSegmentLocator } from '@openreader/tts/types';
import {
  bookmarkInputForSegment,
  findBookmarkForSegment,
  formatBookmarkAge,
  resolveBookmarkOrdinal,
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
    readerType: 'pdf',
    location: '1:0',
    label: null,
    snippet: 'snippet',
    segmentKey: null,
    segmentOrdinal: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  } as DocumentBookmark;
}

const pdfPlan = [
  segment(0, { readerType: 'pdf', page: 1 }),
  segment(1, { readerType: 'pdf', page: 1 }),
  segment(2, { readerType: 'pdf', page: 2 }),
  segment(3, { readerType: 'pdf', page: 3 }),
];

const epubPlan = [
  segment(0, { readerType: 'epub', spineHref: 'a.xhtml', spineIndex: 0, charOffset: 0 }),
  segment(1, { readerType: 'epub', spineHref: 'b.xhtml', spineIndex: 1, charOffset: 0 }),
  segment(2, { readerType: 'epub', spineHref: 'b.xhtml', spineIndex: 1, charOffset: 40 }),
];

describe('bookmarkInputForSegment', () => {
  test('positions a PDF sentence on its own page', () => {
    expect(bookmarkInputForSegment({ readerType: 'pdf', segment: pdfPlan[2], currentLocation: 1, id: ID })).toEqual({
      id: ID,
      readerType: 'pdf',
      location: '2:2',
      snippet: 'Sentence 2.',
      segmentKey: 'key-2',
      segmentOrdinal: 2,
    });
  });

  test('positions an HTML sentence on its block and falls back to the reader location', () => {
    const block = segment(4, { readerType: 'html', location: 'block-3' });
    expect(bookmarkInputForSegment({ readerType: 'html', segment: block, currentLocation: 1, id: ID }))
      .toMatchObject({ readerType: 'html', location: 'html:block-3:4' });
    expect(bookmarkInputForSegment({ readerType: 'html', segment: segment(5, null), currentLocation: 'b', id: ID }))
      .toMatchObject({ readerType: 'html', location: 'html:b:5' });
  });

  test('uses the stable EPUB locator and refuses a segment without one', () => {
    expect(bookmarkInputForSegment({ readerType: 'epub', segment: epubPlan[2], currentLocation: 1, id: ID }))
      .toMatchObject({
        readerType: 'epub',
        locator: { schemaVersion: 1, spineHref: 'b.xhtml', spineIndex: 1, charOffset: 40 },
      });
    expect(bookmarkInputForSegment({
      readerType: 'epub',
      segment: segment(9, { readerType: 'epub', cfi: 'epubcfi(/6/2)' }),
      currentLocation: 1,
      id: ID,
    })).toBeNull();
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
  test('matches by content key before ordinal', () => {
    const byKey = bookmark({ id: 'k', segmentKey: 'key-1', segmentOrdinal: 7 });
    const byOrdinal = bookmark({ id: 'o', segmentOrdinal: 2 });
    expect(findBookmarkForSegment([byKey, byOrdinal], pdfPlan[1])?.id).toBe('k');
    expect(findBookmarkForSegment([byKey, byOrdinal], pdfPlan[2])?.id).toBe('o');
    // A keyed bookmark does not claim another sentence that reuses its ordinal.
    expect(findBookmarkForSegment([byKey], segment(7, null))).toBeNull();
    expect(findBookmarkForSegment([byKey], null)).toBeNull();
  });
});

describe('resolveBookmarkOrdinal', () => {
  test('follows the content key after a re-plan moved the sentence', () => {
    const moved = [segment(0, null), { ...segment(5, null), key: 'key-1' }];
    expect(resolveBookmarkOrdinal(bookmark({ segmentKey: 'key-1', segmentOrdinal: 1 }), moved)).toBe(5);
  });

  test('uses the stored ordinal while it exists in the plan', () => {
    expect(resolveBookmarkOrdinal(bookmark({ segmentKey: 'gone', segmentOrdinal: 3 }), pdfPlan)).toBe(3);
  });

  test('falls back to the stored PDF page when the ordinal is out of range', () => {
    expect(resolveBookmarkOrdinal(bookmark({ location: '2:40', segmentOrdinal: 40 }), pdfPlan)).toBe(2);
    expect(resolveBookmarkOrdinal(bookmark({ location: '9:40', segmentOrdinal: 40 }), pdfPlan)).toBeNull();
  });

  test('falls back to the stored HTML block', () => {
    const htmlPlan = [
      segment(0, { readerType: 'html', location: 'intro' }),
      segment(1, { readerType: 'html', location: 'section-one' }),
    ];
    expect(resolveBookmarkOrdinal(
      bookmark({ readerType: 'html', location: 'html:section-one:12' } as Partial<DocumentBookmark>),
      htmlPlan,
    )).toBe(1);
  });

  test('falls back to the stored EPUB locator', () => {
    const mark = bookmark({
      readerType: 'epub',
      locator: { schemaVersion: 1, spineHref: 'b.xhtml', spineIndex: 1, charOffset: 30 },
    } as Partial<DocumentBookmark>);
    expect(resolveBookmarkOrdinal(mark, epubPlan)).toBe(2);
  });

  test('has no target before the plan exists', () => {
    expect(resolveBookmarkOrdinal(bookmark({ segmentOrdinal: 0 }), [])).toBeNull();
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
