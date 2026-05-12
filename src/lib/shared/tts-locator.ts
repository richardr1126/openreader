import {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
  type TTSSegmentLocator,
} from '@/types/client';
import type { TTSLocation } from '@/types/tts';

export function normalizeTtsLocationKey(location: TTSLocation): string {
  return typeof location === 'number' ? `num:${location}` : `str:${location}`;
}

/**
 * Normalize an EPUB CFI string for whitespace and step-marker variations so two
 * CFIs from the same epub.js rendition can be compared by equality. This is
 * only useful for in-flight CFI deduplication (same device, same render); it
 * does NOT make CFIs stable across viewports — that's what the spine
 * coordinates on the locator are for.
 */
export function normalizeEpubLocationToken(location: string): string {
  return location
    .trim()
    .replace(/\[;s=[ab]\]/gi, '')
    .replace(/\s+/g, '');
}

/**
 * Coarse grouping key used by the sidebar to bucket rows under a chapter
 * heading. EPUB groups by spine item (chapter/section), which is
 * viewport-independent. PDF groups by page. HTML groups by the free-form
 * location string. Multiple rows in the same chapter share this key — that's
 * the whole point.
 *
 * **Do NOT use for storage dedupe.** For that you want `locatorIdentityKey`,
 * which carries the full per-row identity (including `charOffset` for EPUB).
 *
 * Legacy EPUB rows that only carry a CFI (no spine coords) fall back to a
 * group keyed by the raw CFI string — they keep working in isolation but will
 * not co-group with new-shape rows. Such rows are expected to disappear once
 * the user clears the legacy manifest.
 */
export function locatorGroupKey(locator: TTSSegmentLocator | null): string {
  if (!locator) return 'none';
  if (isStableEpubLocator(locator)) {
    return `epub:${locator.spineIndex}:${locator.spineHref}`;
  }
  if (isPdfLocator(locator)) {
    return `pdf:${Math.floor(locator.page)}`;
  }
  if (isHtmlLocator(locator)) {
    return `html:${locator.location}`;
  }
  // Legacy / draft fallback. Keeps the row identifiable but does not promise
  // cross-viewport stability.
  const readerType = locator.readerType || '?';
  const fallback = locator.location ?? (typeof locator.page === 'number' ? String(locator.page) : '');
  return `legacy:${readerType}:${fallback}`;
}

/**
 * Per-row identity key. Unlike `locatorGroupKey`, this includes the full
 * locator-level identity (e.g. `charOffset` for EPUB) so two rows at different
 * positions inside the same spine item never collapse into one entry. Used by
 * the server-side manifest aggregator and anywhere we need "is this the same
 * persisted row?" — not for sidebar chapter buckets.
 */
export function locatorIdentityKey(locator: TTSSegmentLocator | null): string {
  if (!locator) return 'none';
  if (isStableEpubLocator(locator)) {
    return `epub:${locator.spineIndex}:${locator.spineHref}:${locator.charOffset}`;
  }
  if (isPdfLocator(locator)) {
    return `pdf:${Math.floor(locator.page)}`;
  }
  if (isHtmlLocator(locator)) {
    return `html:${locator.location}`;
  }
  const readerType = locator.readerType || '?';
  const fallback = locator.location ?? (typeof locator.page === 'number' ? String(locator.page) : '');
  return `legacy:${readerType}:${fallback}`;
}

function readerTypeRank(readerType: string | undefined): number {
  if (readerType === 'epub') return 0;
  if (readerType === 'pdf') return 1;
  if (readerType === 'html') return 2;
  return 3;
}

/**
 * Total order over locators. Within a readerType:
 *  - EPUB (stable shape): (spineIndex, charOffset). Both numeric — stable
 *    across viewports.
 *  - PDF: page number.
 *  - HTML: location string (lexicographic).
 * Across readerTypes (rarely mixed in practice): stable rank by readerType.
 * Null locators sort last.
 */
export function compareSegmentLocators(
  a: TTSSegmentLocator | null,
  b: TTSSegmentLocator | null,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a.readerType !== b.readerType) {
    return readerTypeRank(a.readerType) - readerTypeRank(b.readerType);
  }
  if (isStableEpubLocator(a) && isStableEpubLocator(b)) {
    if (a.spineIndex !== b.spineIndex) return a.spineIndex - b.spineIndex;
    if (a.charOffset !== b.charOffset) return a.charOffset - b.charOffset;
    return a.spineHref.localeCompare(b.spineHref);
  }
  if (isPdfLocator(a) && isPdfLocator(b)) {
    return Math.floor(a.page) - Math.floor(b.page);
  }
  if (isHtmlLocator(a) && isHtmlLocator(b)) {
    return a.location.localeCompare(b.location);
  }
  // One or both are legacy/draft — fall back to grouped-key compare so the
  // sort is at least deterministic and self-consistent.
  return locatorGroupKey(a).localeCompare(locatorGroupKey(b));
}
