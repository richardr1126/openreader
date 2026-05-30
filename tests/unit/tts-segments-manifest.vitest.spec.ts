import { describe, expect, test } from 'vitest';
import {
  compareManifestSegments,
  decodeManifestCursor,
  dedupeManifestVariants,
  encodeManifestCursor,
  parseManifestPageSize,
} from '../../src/lib/server/tts/segments-manifest';
import { locatorGroupKey, locatorIdentityKey } from '../../src/lib/shared/tts-locator';

describe('tts segments manifest helpers', () => {
  test('dedupe prefers completed variant over newer pending for same settings key', () => {
    const variants = dedupeManifestVariants([
      {
        dedupeKey: 'settings:abc',
        variant: {
          segmentId: 'old-completed',
          settings: null,
          audioPresignUrl: '/audio/old',
          audioFallbackUrl: '/audio/old/fallback',
          durationMs: 1100,
          status: 'completed',
          textLength: 12,
          alignmentWordCount: 2,
          audioKey: 'old',
          updatedAt: 100,
        },
      },
      {
        dedupeKey: 'settings:abc',
        variant: {
          segmentId: 'new-pending',
          settings: null,
          audioPresignUrl: null,
          audioFallbackUrl: null,
          durationMs: null,
          status: 'pending',
          textLength: 15,
          alignmentWordCount: 0,
          audioKey: null,
          updatedAt: 200,
        },
      },
    ]);

    expect(variants).toHaveLength(1);
    expect(variants[0].segmentId).toBe('old-completed');
    expect(variants[0].status).toBe('completed');
  });

  test('dedupe uses status rank as tiebreaker when updatedAt is equal', () => {
    const variants = dedupeManifestVariants([
      {
        dedupeKey: 'settings:abc',
        variant: {
          segmentId: 'pending',
          settings: null,
          audioPresignUrl: null,
          audioFallbackUrl: null,
          durationMs: null,
          status: 'pending',
          textLength: 12,
          alignmentWordCount: 0,
          audioKey: null,
          updatedAt: 123,
        },
      },
      {
        dedupeKey: 'settings:abc',
        variant: {
          segmentId: 'completed',
          settings: null,
          audioPresignUrl: '/audio/new',
          audioFallbackUrl: '/audio/new/fallback',
          durationMs: 1200,
          status: 'completed',
          textLength: 12,
          alignmentWordCount: 2,
          audioKey: 'new',
          updatedAt: 123,
        },
      },
    ]);

    expect(variants).toHaveLength(1);
    expect(variants[0].segmentId).toBe('completed');
    expect(variants[0].status).toBe('completed');
  });

  test('sorts PDF segments deterministically by page and segment index', () => {
    const rows = [
      { groupKey: 'p2-i4', segmentIndex: 4, locator: { readerType: 'pdf' as const, page: 2 } },
      { groupKey: 'p1-i1', segmentIndex: 1, locator: { readerType: 'pdf' as const, page: 1 } },
      { groupKey: 'p1-i0', segmentIndex: 0, locator: { readerType: 'pdf' as const, page: 1 } },
      { groupKey: 'p1-i2', segmentIndex: 2, locator: { readerType: 'pdf' as const, page: 1 } },
    ];

    const sorted = rows.sort(compareManifestSegments);
    expect(sorted.map((row) => row.groupKey)).toEqual(['p1-i0', 'p1-i1', 'p1-i2', 'p2-i4']);
  });

  test('sorts EPUB locators by spineIndex then charOffset (numeric, viewport-stable)', () => {
    // The order below is intentionally jumbled, with spineIndex 10 placed
    // first so that a lexicographic compare on the spine string would put
    // "10" before "2". A correct numeric compare must surface spine 2 first.
    const rows = [
      { groupKey: 'spine-10-off-0', segmentIndex: 0, locator: { readerType: 'epub' as const, spineHref: 'OEBPS/ch10.xhtml', spineIndex: 10, charOffset: 0 } },
      { groupKey: 'spine-2-off-200', segmentIndex: 1, locator: { readerType: 'epub' as const, spineHref: 'OEBPS/ch02.xhtml', spineIndex: 2, charOffset: 200 } },
      { groupKey: 'spine-2-off-50', segmentIndex: 0, locator: { readerType: 'epub' as const, spineHref: 'OEBPS/ch02.xhtml', spineIndex: 2, charOffset: 50 } },
    ];

    const sorted = rows.sort(compareManifestSegments);
    expect(sorted.map((row) => row.groupKey)).toEqual(['spine-2-off-50', 'spine-2-off-200', 'spine-10-off-0']);
  });

  test('groups EPUB rows by spine identity, not by raw CFI', () => {
    // Two rows in the same spine item but at different char offsets must share
    // a groupKey (so the sidebar buckets them together as one chapter), while
    // a row in a different spine sits in its own group.
    const rows = [
      { groupKey: 'a', segmentIndex: 0, locator: { readerType: 'epub' as const, spineHref: 'OEBPS/ch02.xhtml', spineIndex: 2, charOffset: 0, cfi: 'epubcfi(/6/4!/2:0)' } },
      { groupKey: 'b', segmentIndex: 1, locator: { readerType: 'epub' as const, spineHref: 'OEBPS/ch02.xhtml', spineIndex: 2, charOffset: 1024, cfi: 'epubcfi(/6/4!/4:0)' } },
      { groupKey: 'c', segmentIndex: 0, locator: { readerType: 'epub' as const, spineHref: 'OEBPS/ch03.xhtml', spineIndex: 3, charOffset: 0, cfi: 'epubcfi(/6/6!/2:0)' } },
    ];

    const sorted = rows.sort(compareManifestSegments);
    // Recompute groupKey using the production helper to assert the actual
    // grouping behavior rather than the test's hand-labeled groupKey.
    const groupKeys = sorted.map((row) => locatorGroupKey(row.locator));
    expect(groupKeys[0]).toBe(groupKeys[1]); // both ch02
    expect(groupKeys[2]).not.toBe(groupKeys[0]); // ch03 is its own group
  });

  test('manifest aggregator distinguishes rows by identity (regression: per-page rows collapsed by chapter bucket)', () => {
    // Bug reproduction: previously the server-side aggregator keyed rows by
    // `${segmentIndex}|${locatorGroupKey(locator)}`. Because the new EPUB
    // groupKey is chapter-coarse, two persisted rows in different *pages* of
    // the same chapter that happened to share segmentIndex (which is
    // page-relative) collapsed into a single entry — making earlier pages'
    // rows visually "disappear" when later pages were generated.
    //
    // The fix uses `locatorIdentityKey` which includes charOffset for EPUB.
    const page1Row0 = { readerType: 'epub' as const, spineHref: 'OEBPS/ch02.xhtml', spineIndex: 2, charOffset: 0 };
    const page2Row0 = { readerType: 'epub' as const, spineHref: 'OEBPS/ch02.xhtml', spineIndex: 2, charOffset: 2048 };

    // Same chapter bucket (sidebar grouping should put them under one chapter header).
    expect(locatorGroupKey(page1Row0)).toBe(locatorGroupKey(page2Row0));
    // Different storage identity (server aggregator must NOT collapse them).
    const segmentIndex = 0;
    const k1 = `${segmentIndex}|${locatorIdentityKey(page1Row0)}`;
    const k2 = `${segmentIndex}|${locatorIdentityKey(page2Row0)}`;
    expect(k1).not.toBe(k2);
  });

  test('encodes and decodes cursors', () => {
    const raw = {
      locatorReaderRank: 0,
      locatorSpineIndex: 2,
      locatorCharOffset: 128,
      locatorSpineHref: 'OEBPS/ch02.xhtml',
      locatorPage: -1,
      locatorLocation: '',
      segmentIndex: 4,
      locatorIdentityKey: 'epub:2:OEBPS/ch02.xhtml:128',
      segmentEntryId: 'entry-4',
    };
    const encoded = encodeManifestCursor(raw);
    expect(decodeManifestCursor(encoded)).toEqual(raw);
    expect(decodeManifestCursor('not-base64')).toBeNull();
    const malformed = Buffer.from(JSON.stringify({ bad: true }), 'utf8').toString('base64url');
    expect(decodeManifestCursor(malformed)).toBeNull();
  });

  test('clamps page size bounds', () => {
    expect(parseManifestPageSize(null)).toBe(150);
    expect(parseManifestPageSize('10')).toBe(25);
    expect(parseManifestPageSize('900')).toBe(500);
    expect(parseManifestPageSize('200')).toBe(200);
  });
});
