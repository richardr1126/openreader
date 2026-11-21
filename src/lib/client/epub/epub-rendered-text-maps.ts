'use client';

import type { Contents, Rendition } from 'epubjs';
import {
  normalizeSegmentIdentityText,
  type CanonicalTtsSegment,
} from '@openreader/tts/segment-plan';
import { createRangeCfi } from '@/lib/client/epub';
import {
  collectEpubBodyCharacters,
  resolveNormalizedRangeStartOffset,
  resolveSpineFromCfi,
  type EpubSpineCoord,
} from '@/lib/client/epub/spine-coordinates';
import { isStableEpubLocator } from '@/types/client';

type EpubMappedPosition = {
  node: Text;
  offset: number;
};

/**
 * The normalized text of one rendered spine section, in the same character
 * space as worker-plan EPUB locators: index `i` is spine `charOffset` `i`.
 *
 * It spans the whole section, not the page. Page bounds come from epub.js
 * location CFIs, which can end a page before text it still shows; a map cut
 * there left a sentence's last words on no page at all.
 */
export type EpubRenderedTextMap = {
  sourceKey: string;
  spineHref: string;
  spineIndex: number;
  chars: EpubMappedPosition[];
  // `text[i]` is the character at `chars[i]`. Used to locate spoken words by
  // content within a resolved segment region.
  text: string;
  content: Contents;
};

/**
 * Text maps for the rendered sections. A section whose document is unchanged
 * keeps its map, so turning a page within it leaves painted ranges intact.
 */
export const buildRenderedTextMaps = (
  rendition: Rendition,
  previous: readonly EpubRenderedTextMap[] = [],
): EpubRenderedTextMap[] => {
  const contents = rendition.getContents() as unknown as Contents | Contents[];
  const contentsArray = Array.isArray(contents) ? contents : [contents];
  const maps: EpubRenderedTextMap[] = [];

  for (const content of contentsArray) {
    const body = content?.document?.body;
    if (!body) continue;
    const reused = previous.find((map) => map.content.document === content.document);
    if (reused) {
      maps.push(reused);
      continue;
    }
    const spine = resolveSpineFromCfi(rendition.book, content.sectionIndex);
    if (!spine) continue;
    const normalized = collectEpubBodyCharacters(body);
    maps.push({
      sourceKey: `spine:${spine.index}:${spine.href}`,
      spineHref: spine.href,
      spineIndex: spine.index,
      chars: normalized.map((token) => token.pos),
      text: normalized.map((token) => token.char).join(''),
      content,
    });
  }

  return maps;
};

/**
 * The stable spine coordinate where a rendered page starts, plus whether the
 * page shows any text. Resolved against the rendered document itself, in the
 * same character space as its text map.
 */
export const resolveRenderedPageStart = (
  maps: readonly EpubRenderedTextMap[],
  startCfi: string,
  endCfi: string,
): (EpubSpineCoord & { hasReadableText: boolean }) | null => {
  for (const map of maps) {
    let start: Range | null = null;
    try {
      start = map.content.range(startCfi);
    } catch {
      // Spread mode shows sections that cannot resolve the other's CFI.
    }
    if (!start) continue;
    const charOffset = resolveNormalizedRangeStartOffset(start, map.chars);
    if (charOffset === null) continue;
    let hasReadableText = false;
    try {
      hasReadableText = Boolean(map.content.range(createRangeCfi(startCfi, endCfi))?.toString().trim());
    } catch {
      hasReadableText = false;
    }
    return { spineHref: map.spineHref, spineIndex: map.spineIndex, charOffset, hasReadableText };
  }
  return null;
};

export const createRangeFromMappedOffsets = (
  map: EpubRenderedTextMap,
  startOffset: number,
  endOffset: number,
): Range | null => {
  const start = Math.max(0, Math.min(startOffset, map.chars.length));
  const end = Math.max(start, Math.min(endOffset, map.chars.length));
  if (end <= start) return null;

  const startPosition = map.chars[start];
  const endPosition = map.chars[end - 1];
  if (!startPosition || !endPosition) return null;

  const doc = startPosition.node.ownerDocument;
  const range = doc.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);
  return range;
};

export const resolveVisibleSegmentRange = (
  maps: readonly EpubRenderedTextMap[],
  segment: CanonicalTtsSegment | null | undefined,
): { map: EpubRenderedTextMap; range: Range; startOffset: number; endOffset: number } | null => {
  const locator = segment?.ownerLocator;
  if (!segment || !isStableEpubLocator(locator)) return null;

  for (const map of maps) {
    if (map.spineHref !== locator.spineHref || map.spineIndex !== locator.spineIndex) continue;
    const startOffset = Math.max(0, Math.floor(locator.charOffset));
    const endOffset = Math.min(
      map.chars.length,
      startOffset + Math.max(1, normalizeSegmentIdentityText(segment.text).length),
    );
    const range = createRangeFromMappedOffsets(map, startOffset, endOffset);
    if (range) return { map, range, startOffset, endOffset };
  }

  return null;
};

/**
 * Whether a spoken word is laid out past the visible page, in the reading
 * direction. Narration follows a segment by its start, so a sentence that runs
 * onto the next page would be heard there while this one stays up; the page
 * turns instead on the first spoken word it does not show, as the iOS reader
 * does. Both rects are in the same (top-level) coordinate space.
 */
export const isRectPastViewport = (
  word: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  viewport: Pick<DOMRect, 'right' | 'bottom'>,
): boolean => (
  (word.width > 0 || word.height > 0)
  && (word.left >= viewport.right - 1 || word.top >= viewport.bottom - 1)
);

/** A range's first line box, in top-level page coordinates. */
export const rangeViewportRect = (range: Range): DOMRect | null => {
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect) return null;
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement;
  const offset = frame?.getBoundingClientRect();
  return new DOMRect(
    rect.left + (offset?.left ?? 0),
    rect.top + (offset?.top ?? 0),
    rect.width,
    rect.height,
  );
};
