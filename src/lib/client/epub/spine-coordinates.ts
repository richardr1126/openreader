import type { Book } from 'epubjs';
import type Section from 'epubjs/types/section';

import { normalizeMappedChars, type MappedChar } from '@/lib/client/highlight-char-map';

/** Stable, viewport-independent coordinates inside one EPUB spine item. */
export interface EpubSpineCoord {
  spineHref: string;
  spineIndex: number;
  charOffset: number;
}

type EpubDomPosition = {
  node: Text;
  offset: number;
};

/** Resolve a CFI to the spine item that owns it. */
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

/** A section body's text, normalized into worker-plan locator character space. */
export const collectEpubBodyCharacters = (body: HTMLElement): Array<MappedChar<EpubDomPosition>> => {
  const doc = body.ownerDocument;
  const nodeFilter = doc.defaultView?.NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(body, nodeFilter.SHOW_TEXT);
  const mapped: Array<MappedChar<EpubDomPosition>> = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node.textContent ?? '';
    for (let offset = 0; offset < text.length; offset += 1) {
      mapped.push({ char: text[offset], pos: { node, offset } });
    }
    node = walker.nextNode() as Text | null;
  }
  return normalizeMappedChars(mapped);
};

/**
 * Convert a DOM range start directly into the canonical normalized character
 * space used by worker-plan EPUB locators. This intentionally does not search
 * for rendered page text: page strings are not stable across pagination,
 * spreads, markup boundaries, or non-text content.
 */
export function resolveNormalizedRangeStartOffset(
  range: Range,
  positions: ReadonlyArray<EpubDomPosition>,
): number | null {
  // Positions are in document order, so the first one at or after the range
  // start is found by bisection.
  let low = 0;
  let high = positions.length;
  try {
    while (low < high) {
      const mid = (low + high) >> 1;
      const position = positions[mid];
      if (range.comparePoint(position.node, position.offset) >= 0) high = mid;
      else low = mid + 1;
    }
  } catch {
    return null;
  }
  return low;
}
