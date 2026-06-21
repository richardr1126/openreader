import type { Book } from 'epubjs';
import type Section from 'epubjs/types/section';

import { normalizeSegmentIdentityText } from '@openreader/tts/segment-plan';
import type { TTSSegmentLocator } from '@/types/client';

/**
 * Stable book coordinates for an EPUB anchor (a page chunk or a sentence).
 *
 * `charOffset` is measured in the *normalized* spine-item text — i.e. the same
 * normalization used by segmentKey (see normalizeSegmentIdentityText). This is
 * deliberate: we want a coordinate that is stable across viewports and that
 * matches the identity space audio segments already live in. The coordinate is
 * NOT intended to round-trip back to a CFI; the optional `cfi` field on the
 * locator carries that jump hint separately.
 */
export interface EpubSpineCoord {
  spineHref: string;
  spineIndex: number;
  charOffset: number;
}

interface SectionLike {
  index: number;
  href?: string;
  load?: ((request?: unknown) => Promise<Document> | Document) | undefined;
  unload?: () => void;
}

const PLAIN_TEXT_CACHE = new WeakMap<Book, Map<string, string>>();

const getCacheBucket = (book: Book): Map<string, string> => {
  let bucket = PLAIN_TEXT_CACHE.get(book);
  if (!bucket) {
    bucket = new Map();
    PLAIN_TEXT_CACHE.set(book, bucket);
  }
  return bucket;
};

/**
 * Reset the cached plain-text-by-href map for a book. Call when the underlying
 * EPUB resource is destroyed/re-opened so we don't hand out text from an old
 * book instance.
 */
export function invalidateSpinePlainTextCache(book: Book): void {
  PLAIN_TEXT_CACHE.delete(book);
}

/**
 * Resolve a CFI (or href, or spine index) to its spine item identity.
 * Returns null when the CFI can't be resolved by epub.js.
 */
export function resolveSpineFromCfi(
  book: Book,
  cfiOrHrefOrIndex: string | number | undefined | null,
): { href: string; index: number } | null {
  if (cfiOrHrefOrIndex === null || cfiOrHrefOrIndex === undefined) return null;
  try {
    const section = book.spine.get(cfiOrHrefOrIndex as never) as Section | undefined;
    if (!section) return null;
    const href = section.href;
    const index = section.index;
    if (typeof href !== 'string' || !href || typeof index !== 'number' || !Number.isFinite(index)) {
      return null;
    }
    return { href, index };
  } catch {
    return null;
  }
}

/**
 * Load the spine item identified by href and return its plain text content.
 * Results are memoised per Book instance so this is safe to call repeatedly.
 *
 * Returns the empty string on any failure — callers should treat that as
 * "couldn't resolve coordinates" and fall back.
 */
export async function getSpineItemPlainText(book: Book, href: string): Promise<string> {
  if (!href) return '';
  const cache = getCacheBucket(book);
  const hit = cache.get(href);
  if (hit !== undefined) return hit;

  try {
    const section = book.spine.get(href) as Section | undefined;
    if (!section || typeof section.load !== 'function') {
      cache.set(href, '');
      return '';
    }
    // epub.js Section.load accepts a request function; book.load is the canonical resolver.
    //
    // IMPORTANT: `section.load()` resolves to the spine item's `<html>`
    // Element (NOT a Document). See epubjs/src/section.js — `this.contents =
    // xml.documentElement; loading.resolve(this.contents);`. So neither
    // `.body` nor `.documentElement` exists on the resolved value; pulling
    // text via those paths silently returns undefined and we end up with an
    // empty spine string. We have to query for `<body>` inside the element
    // (or fall back to the element's own textContent if there's no body).
    const loaded = await Promise.resolve(
      (section as unknown as SectionLike).load!(book.load.bind(book)),
    );
    const root = loaded as Element | Document | null | undefined;
    let raw = '';
    if (root) {
      // Handle both shapes — most epubjs versions resolve to an Element, but
      // be defensive in case a future version returns a Document.
      if ('body' in (root as Document) && (root as Document).body) {
        raw = (root as Document).body.textContent ?? '';
      } else if (typeof (root as Element).querySelector === 'function') {
        const body = (root as Element).querySelector('body');
        raw = body?.textContent ?? (root as Element).textContent ?? '';
      } else if ('textContent' in (root as Element)) {
        raw = (root as Element).textContent ?? '';
      }
    }
    const text = typeof raw === 'string' ? raw : '';
    cache.set(href, text);
    try {
      (section as unknown as SectionLike).unload?.();
    } catch {
      /* no-op */
    }
    return text;
  } catch {
    cache.set(href, '');
    return '';
  }
}

/**
 * Find the character offset (in normalized space) of `segmentText` inside
 * `spineText`. The optional `hintNormalized` narrows the search to start at or
 * after that normalized offset, which disambiguates repeated phrases.
 *
 * Falls back to a from-start search when the forward search misses — useful
 * for single-shot resolution where the hint may be inaccurate (e.g. a walker
 * reporting a chunk start that doesn't quite align). **Do NOT use this in a
 * monotonic per-sentence walk** — the from-start fallback can return an
 * occurrence *before* the cursor, which silently reorders rows. Use
 * `resolveMonotonicSentenceOffsets` for that case.
 *
 * Returns -1 if the segment text is not found.
 */
export function findSegmentOffset(
  spineText: string,
  segmentText: string,
  hintNormalized: number = 0,
): number {
  const haystack = normalizeSegmentIdentityText(spineText);
  const needle = normalizeSegmentIdentityText(segmentText);
  if (!haystack || !needle) return -1;
  const startFrom = Math.max(0, Math.min(haystack.length, Math.floor(hintNormalized)));
  const direct = haystack.indexOf(needle, startFrom);
  if (direct !== -1) return direct;
  // Fall back to a search from the beginning — the hint can be wrong if the
  // walker reported a chunk start that doesn't align with our segment.
  if (startFrom > 0) {
    const fromStart = haystack.indexOf(needle);
    if (fromStart !== -1) return fromStart;
  }
  return -1;
}

/**
 * Resolve per-sentence character offsets within a spine item's plain text, in
 * document order. Searches forward only — each sentence's offset is found at
 * or after the previous match's end+1. If a sentence's text isn't found ahead
 * of the cursor (e.g. it contains a phrase that only recurs earlier in the
 * chapter), the current cursor value is reused so the result stays
 * **monotonically non-decreasing**.
 *
 * This guarantee is the whole point: it prevents the sidebar's sort from
 * pulling a later-on-the-page sentence backwards because a substring of it
 * happens to appear in a chapter heading or earlier passage. Using
 * `findSegmentOffset` in a loop would let that happen via its from-start
 * fallback — which is correct for single-shot lookups and wrong here.
 *
 * Returns an array of offsets, one per input sentence (empty/falsy sentences
 * get the current cursor value). All values are >= 0 and the sequence is
 * monotonic non-decreasing.
 */
export function resolveMonotonicSentenceOffsets(
  spineText: string,
  sentences: readonly string[],
): number[] {
  const haystack = normalizeSegmentIdentityText(spineText);
  const offsets: number[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    if (!sentence) {
      offsets.push(cursor);
      continue;
    }
    const needle = normalizeSegmentIdentityText(sentence);
    const found = needle && haystack ? haystack.indexOf(needle, cursor) : -1;
    if (found >= 0) {
      offsets.push(found);
      cursor = found + 1;
    } else {
      offsets.push(cursor);
    }
  }
  return offsets;
}

/**
 * Resolve a chunk-level anchor (e.g. for a rendered page or for the current
 * viewport's start CFI). Returns the spine identity plus the normalized
 * character offset where this chunk begins in the spine item's text.
 *
 * Returns null when the chunk text can't be located inside the spine item.
 * Playback start coordinates must be real; offset 0 would silently start audio
 * from the chapter beginning or title page when the rendered window did not map.
 */
export async function buildEpubChunkAnchor(
  book: Book,
  chunkCfi: string,
  chunkText: string,
): Promise<(EpubSpineCoord & { spineText: string }) | null> {
  const spine = resolveSpineFromCfi(book, chunkCfi);
  if (!spine) return null;
  const spineText = await getSpineItemPlainText(book, spine.href);
  const chunkOffset = chunkText ? findSegmentOffset(spineText, chunkText, 0) : -1;
  if (chunkOffset < 0) return null;
  return {
    spineHref: spine.href,
    spineIndex: spine.index,
    charOffset: chunkOffset,
    spineText,
  };
}

/**
 * Build the EPUB locator for a single segment, given an already-resolved chunk
 * anchor. Reuses the cached spine plain text via the anchor.
 *
 * `cfi` is recorded as a soft jump hint only and is intentionally NOT part of
 * the locator's identity.
 */
export function buildEpubLocatorFromChunk(
  anchor: EpubSpineCoord & { spineText: string },
  segmentText: string,
  cfi?: string,
): TTSSegmentLocator {
  // Forward-only search from the chunk anchor. Critically, we do NOT use
  // `findSegmentOffset` here because its from-start fallback would let a
  // segment's offset jump *before* the chunk anchor — which means a
  // sentence from a later page that happens to contain text also present
  // earlier in the chapter (chapter heading, refrain, common phrase) would
  // be persisted with an offset somewhere in an earlier page, causing it
  // to interleave out-of-order in the sidebar's sort.
  const haystack = normalizeSegmentIdentityText(anchor.spineText);
  const needle = normalizeSegmentIdentityText(segmentText);
  const found = needle && haystack ? haystack.indexOf(needle, anchor.charOffset) : -1;
  const charOffset = found >= 0 ? found : anchor.charOffset;
  const locator: TTSSegmentLocator = {
    readerType: 'epub',
    spineHref: anchor.spineHref,
    spineIndex: anchor.spineIndex,
    charOffset,
  };
  if (cfi) locator.cfi = cfi;
  return locator;
}

/**
 * One-shot helper: resolve a single segment's locator without an anchor in
 * hand. Loads spine text on demand (cached). Returns null when the CFI doesn't
 * resolve to a spine item.
 */
export async function buildEpubLocator(
  book: Book,
  chunkCfi: string,
  segmentText: string,
  chunkText?: string,
): Promise<TTSSegmentLocator | null> {
  const anchor = await buildEpubChunkAnchor(book, chunkCfi, chunkText ?? segmentText);
  if (!anchor) return null;
  return buildEpubLocatorFromChunk(anchor, segmentText, chunkCfi);
}
