import { describe, expect, test } from 'vitest';
import {
  compareSegmentLocators,
  locatorGroupKey,
  locatorIdentityKey,
  normalizeEpubLocationToken,
} from '../../src/lib/shared/tts-locator';
import {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
  type TTSSegmentLocator,
} from '../../src/types/client';

const epubLocator = (
  spineHref: string,
  spineIndex: number,
  charOffset: number,
  cfi?: string,
): TTSSegmentLocator => ({
  readerType: 'epub',
  spineHref,
  spineIndex,
  charOffset,
  ...(cfi ? { cfi } : {}),
});

describe('locatorGroupKey', () => {
  test('groups stable EPUB locators by spine index and href', () => {
    expect(locatorGroupKey(epubLocator('OEBPS/ch02.xhtml', 2, 0))).toBe('epub:2:OEBPS/ch02.xhtml');
    // Different charOffset, same spine → same group (sidebar bucket is chapter-sized).
    expect(locatorGroupKey(epubLocator('OEBPS/ch02.xhtml', 2, 1024)))
      .toBe(locatorGroupKey(epubLocator('OEBPS/ch02.xhtml', 2, 0)));
    // Different spine → different group.
    expect(locatorGroupKey(epubLocator('OEBPS/ch03.xhtml', 3, 0)))
      .not.toBe(locatorGroupKey(epubLocator('OEBPS/ch02.xhtml', 2, 0)));
  });

  test('groups PDF locators by page', () => {
    expect(locatorGroupKey({ readerType: 'pdf', page: 7 })).toBe('pdf:7');
  });

  test('groups HTML locators by location', () => {
    expect(locatorGroupKey({ readerType: 'html', location: '#anchor' })).toBe('html:#anchor');
  });

  test('returns "none" for null locators', () => {
    expect(locatorGroupKey(null)).toBe('none');
  });

  test('falls back to a legacy group key for EPUB drafts missing spine coords', () => {
    // A draft EPUB locator (just a CFI) should not co-group with stable rows.
    const draft: TTSSegmentLocator = { readerType: 'epub', location: 'epubcfi(/6/8!/4:0)' };
    expect(locatorGroupKey(draft)).toContain('legacy');
  });
});

describe('locatorIdentityKey', () => {
  test('two EPUB rows in the same chapter at different charOffsets get distinct identity keys', () => {
    // This is the bug that caused page-N rows to swallow page-(N+1) rows in
    // the server-side manifest aggregator: the previous code keyed by the
    // chapter-coarse groupKey, collapsing distinct rows into a single bucket.
    const a = epubLocator('OEBPS/ch02.xhtml', 2, 0);
    const b = epubLocator('OEBPS/ch02.xhtml', 2, 1024);
    expect(locatorIdentityKey(a)).not.toBe(locatorIdentityKey(b));
  });

  test('two EPUB rows at the same coordinate get equal identity keys', () => {
    // Identity is content-of-locator only; the optional cfi jump hint is
    // intentionally not part of identity.
    const a = epubLocator('OEBPS/ch02.xhtml', 2, 50, 'epubcfi(/6/4!/2:0)');
    const b = epubLocator('OEBPS/ch02.xhtml', 2, 50, 'epubcfi(/6/4!/2:8)');
    expect(locatorIdentityKey(a)).toBe(locatorIdentityKey(b));
  });

  test('chapter-coarse group key collides across rows that identity-key keeps distinct', () => {
    // Sanity-check the relationship between the two helpers.
    const a = epubLocator('OEBPS/ch02.xhtml', 2, 0);
    const b = epubLocator('OEBPS/ch02.xhtml', 2, 1024);
    expect(locatorGroupKey(a)).toBe(locatorGroupKey(b)); // same chapter bucket
    expect(locatorIdentityKey(a)).not.toBe(locatorIdentityKey(b)); // distinct rows
  });
});

describe('compareSegmentLocators', () => {
  test('orders EPUB rows by spineIndex then charOffset numerically', () => {
    // Spine 10 must come AFTER spine 2 — a lexicographic compare would
    // wrongly place "10" before "2".
    const a = epubLocator('a.xhtml', 10, 0);
    const b = epubLocator('b.xhtml', 2, 0);
    expect(compareSegmentLocators(a, b)).toBeGreaterThan(0);
    expect(compareSegmentLocators(b, a)).toBeLessThan(0);
  });

  test('within the same spine, orders by charOffset', () => {
    const a = epubLocator('OEBPS/ch02.xhtml', 2, 50);
    const b = epubLocator('OEBPS/ch02.xhtml', 2, 1000);
    expect(compareSegmentLocators(a, b)).toBeLessThan(0);
    expect(compareSegmentLocators(b, a)).toBeGreaterThan(0);
  });

  test('treats equal stable EPUB locators as equal regardless of optional cfi hint', () => {
    const a = epubLocator('OEBPS/ch02.xhtml', 2, 50, 'epubcfi(/6/4!/2:0)');
    const b = epubLocator('OEBPS/ch02.xhtml', 2, 50, 'epubcfi(/6/4!/2:8)');
    // cfi is a soft jump hint, not part of identity/sort.
    expect(compareSegmentLocators(a, b)).toBe(0);
  });

  test('orders PDF locators by page numerically', () => {
    const a: TTSSegmentLocator = { readerType: 'pdf', page: 2 };
    const b: TTSSegmentLocator = { readerType: 'pdf', page: 10 };
    expect(compareSegmentLocators(a, b)).toBeLessThan(0);
  });

  test('orders HTML locators by location numerically when both look like integers', () => {
    // Same regression class as the EPUB spineIndex test: "2" must come BEFORE
    // "10" in the segments sidebar, not after it (lexicographic compare would
    // sort "10" between "1" and "2").
    const a: TTSSegmentLocator = { readerType: 'html', location: '2' };
    const b: TTSSegmentLocator = { readerType: 'html', location: '10' };
    expect(compareSegmentLocators(a, b)).toBeLessThan(0);
    expect(compareSegmentLocators(b, a)).toBeGreaterThan(0);
  });

  test('falls back to lexicographic compare for free-form HTML locations', () => {
    // Legacy / non-numeric HTML locations (e.g. anchor ids) should still
    // produce a stable ordering.
    const a: TTSSegmentLocator = { readerType: 'html', location: '#alpha' };
    const b: TTSSegmentLocator = { readerType: 'html', location: '#beta' };
    expect(compareSegmentLocators(a, b)).toBeLessThan(0);
  });

  test('null locators sort last', () => {
    expect(compareSegmentLocators(null, { readerType: 'pdf', page: 1 })).toBeGreaterThan(0);
    expect(compareSegmentLocators({ readerType: 'pdf', page: 1 }, null)).toBeLessThan(0);
    expect(compareSegmentLocators(null, null)).toBe(0);
  });
});

describe('type guards', () => {
  test('isStableEpubLocator requires all spine fields', () => {
    expect(isStableEpubLocator(epubLocator('a.xhtml', 0, 0))).toBe(true);
    expect(isStableEpubLocator({ readerType: 'epub', spineHref: 'a.xhtml' })).toBe(false);
    expect(isStableEpubLocator({ readerType: 'epub', location: 'epubcfi(...)' })).toBe(false);
    expect(isStableEpubLocator(null)).toBe(false);
    expect(isStableEpubLocator({ readerType: 'pdf', page: 1 })).toBe(false);
  });

  test('isPdfLocator narrows PDF rows', () => {
    expect(isPdfLocator({ readerType: 'pdf', page: 3 })).toBe(true);
    expect(isPdfLocator({ readerType: 'pdf' })).toBe(false);
    expect(isPdfLocator(epubLocator('a.xhtml', 0, 0))).toBe(false);
  });

  test('isHtmlLocator narrows HTML rows', () => {
    expect(isHtmlLocator({ readerType: 'html', location: '#x' })).toBe(true);
    expect(isHtmlLocator({ readerType: 'html', location: '' })).toBe(false);
    expect(isHtmlLocator({ readerType: 'pdf', page: 1 })).toBe(false);
  });
});

describe('normalizeEpubLocationToken', () => {
  test('strips whitespace and step markers but preserves identity', () => {
    const a = normalizeEpubLocationToken('epubcfi(/6/8!/4:0)');
    const b = normalizeEpubLocationToken('  epubcfi(/6/8[;s=a]!/4:0)  ');
    expect(a).toBe(b);
  });
});
