import type { TTSSegmentLocator } from '@/types/client';
import type { TTSLocation } from '@/types/tts';

const naturalLocationCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function normalizeEpubLocationToken(location: string): string {
  return location
    .trim()
    .replace(/\[;s=[ab]\]/gi, '')
    .replace(/\s+/g, '');
}

export function normalizeTtsLocationKey(location: TTSLocation): string {
  return typeof location === 'number' ? `num:${location}` : `str:${location}`;
}

export function locatorGroupKey(locator: TTSSegmentLocator | null): string {
  if (!locator) return 'none';
  const page = typeof locator.page === 'number' && Number.isFinite(locator.page)
    ? String(Math.floor(locator.page))
    : '';
  const location = typeof locator.location === 'string' ? locator.location : '';
  const readerType = locator.readerType || '';
  return `p:${page}|l:${location}|r:${readerType}`;
}

export function compareLocationTokens(a: string, b: string): number {
  return naturalLocationCollator.compare(
    normalizeEpubLocationToken(a),
    normalizeEpubLocationToken(b),
  );
}

export function compareSegmentLocators(
  a: TTSSegmentLocator | null,
  b: TTSSegmentLocator | null,
): number {
  const aPage = typeof a?.page === 'number' && Number.isFinite(a.page)
    ? Math.floor(a.page)
    : Number.MAX_SAFE_INTEGER;
  const bPage = typeof b?.page === 'number' && Number.isFinite(b.page)
    ? Math.floor(b.page)
    : Number.MAX_SAFE_INTEGER;
  if (aPage !== bPage) return aPage - bPage;

  const aLocation = typeof a?.location === 'string' ? a.location : '';
  const bLocation = typeof b?.location === 'string' ? b.location : '';
  const byLocation = compareLocationTokens(aLocation, bLocation);
  if (byLocation !== 0) return byLocation;

  const aReaderType = a?.readerType || '';
  const bReaderType = b?.readerType || '';
  return aReaderType.localeCompare(bReaderType);
}
