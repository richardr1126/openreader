import {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
  type TTSSegmentLocator,
} from './types';
import type { TTSLocation } from './types';

/**
 * Validate and shape a locator for persistence. EPUB locators MUST carry the
 * stable spine coordinates (`spineHref`, `spineIndex`, `charOffset`) — the
 * legacy CFI-only shape is rejected (returns null) so we never store a
 * viewport-dependent locator. PDF and HTML branches are unchanged.
 *
 * This is a pure function (types only) and lives here — rather than in
 * `segments.ts` — so client bundles can import it without pulling in the
 * server-only toolchain (`fs`, `crypto`, ffmpeg/`child_process`).
 */
export function normalizeLocator(locator: TTSSegmentLocator | undefined): TTSSegmentLocator | null {
  if (!locator) return null;
  if (locator.readerType === 'pdf') {
    if (typeof locator.page !== 'number' || !Number.isFinite(locator.page)) return null;
    return {
      readerType: 'pdf',
      page: Math.max(1, Math.floor(locator.page)),
      ...(typeof locator.blockId === 'string' && locator.blockId.trim()
        ? { blockId: locator.blockId.trim() }
        : {}),
    };
  }
  if (locator.readerType === 'html') {
    if (typeof locator.location !== 'string' || !locator.location.trim()) return null;
    return {
      readerType: 'html',
      location: locator.location.trim(),
    };
  }
  if (locator.readerType === 'epub') {
    const spineHref = typeof locator.spineHref === 'string' ? locator.spineHref.trim() : '';
    const spineIndex = typeof locator.spineIndex === 'number' && Number.isFinite(locator.spineIndex)
      ? Math.max(0, Math.floor(locator.spineIndex))
      : -1;
    const charOffset = typeof locator.charOffset === 'number' && Number.isFinite(locator.charOffset)
      ? Math.max(0, Math.floor(locator.charOffset))
      : -1;
    if (!spineHref || spineIndex < 0 || charOffset < 0) {
      // Reject draft/legacy EPUB locators that lack stable coordinates. The
      // client is expected to resolve these via the spine-coordinates helper
      // before posting.
      return null;
    }
    const normalized: TTSSegmentLocator = {
      readerType: 'epub',
      spineHref,
      spineIndex,
      charOffset,
    };
    if (typeof locator.cfi === 'string' && locator.cfi.trim()) {
      normalized.cfi = locator.cfi.trim();
    }
    return normalized;
  }
  return null;
}

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
    const blockPart = typeof locator.blockId === 'string' && locator.blockId.trim()
      ? `:${locator.blockId.trim()}`
      : '';
    return `pdf:${Math.floor(locator.page)}${blockPart}`;
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
    const pageCmp = Math.floor(a.page) - Math.floor(b.page);
    if (pageCmp !== 0) return pageCmp;
    const aBlock = typeof a.blockId === 'string' ? a.blockId : '';
    const bBlock = typeof b.blockId === 'string' ? b.blockId : '';
    return aBlock.localeCompare(bBlock);
  }
  if (isHtmlLocator(a) && isHtmlLocator(b)) {
    // When both locations look like positive integers (HTML reader blocks),
    // compare numerically so "10" sorts after "2" instead of between "1" and
    // "2". Falls back to lexicographic for legacy free-form locations.
    const an = /^\d+$/.test(a.location) ? Number(a.location) : NaN;
    const bn = /^\d+$/.test(b.location) ? Number(b.location) : NaN;
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      return an - bn;
    }
    return a.location.localeCompare(b.location);
  }
  // One or both are legacy/draft — fall back to grouped-key compare so the
  // sort is at least deterministic and self-consistent.
  return locatorGroupKey(a).localeCompare(locatorGroupKey(b));
}
