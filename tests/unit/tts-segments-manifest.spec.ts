import { expect, test } from '@playwright/test';
import {
  compareManifestSegments,
  decodeManifestCursor,
  dedupeManifestVariants,
  encodeManifestCursor,
  parseManifestPageSize,
} from '../../src/lib/server/tts/segments-manifest';

test.describe('tts segments manifest helpers', () => {
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

  test('sorts segments deterministically by page, location, and segment index', () => {
    const rows = [
      { groupKey: 'c', segmentIndex: 4, locator: { page: 2, location: 'z' } },
      { groupKey: 'a', segmentIndex: 1, locator: { page: 1, location: 'b' } },
      { groupKey: 'b', segmentIndex: 0, locator: { page: 1, location: 'a' } },
      { groupKey: 'd', segmentIndex: 2, locator: { page: 1, location: 'a' } },
    ];

    const sorted = rows.sort(compareManifestSegments);
    expect(sorted.map((row) => row.groupKey)).toEqual(['b', 'd', 'a', 'c']);
  });

  test('sorts EPUB CFI locations naturally instead of lexicographically', () => {
    const rows = [
      { groupKey: 'ten', segmentIndex: 0, locator: { location: 'epubcfi(/6/10!/4/2)', readerType: 'epub' as const } },
      { groupKey: 'two-b', segmentIndex: 1, locator: { location: 'epubcfi(/6/2!/4/2)', readerType: 'epub' as const } },
      { groupKey: 'two-a', segmentIndex: 0, locator: { location: 'epubcfi(/6/2!/4/2)', readerType: 'epub' as const } },
    ];

    const sorted = rows.sort(compareManifestSegments);
    expect(sorted.map((row) => row.groupKey)).toEqual(['two-a', 'two-b', 'ten']);
  });

  test('encodes and decodes cursors', () => {
    const raw = '3|p:2|l:epubcfi(/6/2)|r:epub';
    const encoded = encodeManifestCursor(raw);
    expect(decodeManifestCursor(encoded)).toBe(raw);
    expect(decodeManifestCursor('not-base64')).toBeNull();
  });

  test('clamps page size bounds', () => {
    expect(parseManifestPageSize(null)).toBe(150);
    expect(parseManifestPageSize('10')).toBe(25);
    expect(parseManifestPageSize('900')).toBe(500);
    expect(parseManifestPageSize('200')).toBe(200);
  });
});
