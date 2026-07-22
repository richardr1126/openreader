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

const collectBodyCharacters = (body: HTMLElement): Array<MappedChar<EpubDomPosition>> => {
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
  normalizedCharacters: ReadonlyArray<MappedChar<EpubDomPosition>>,
): number | null {
  for (let index = 0; index < normalizedCharacters.length; index += 1) {
    const position = normalizedCharacters[index]?.pos;
    if (!position) continue;
    try {
      if (range.comparePoint(position.node, position.offset) >= 0) return index;
    } catch {
      return null;
    }
  }
  return normalizedCharacters.length;
}

/**
 * Resolve the committed rendition range to one stable spine coordinate.
 * The CFI identifies the spine item; the range start identifies the exact
 * normalized character offset in that item's DOM.
 */
export function buildEpubRangeStartAnchor(
  book: Book,
  startCfi: string,
  renderedRange: Range,
): EpubSpineCoord | null {
  const spine = resolveSpineFromCfi(book, startCfi);
  if (!spine) return null;

  const doc = renderedRange.startContainer.ownerDocument;
  const body = doc?.body;
  if (!body) return null;

  const normalizedCharacters = collectBodyCharacters(body);
  const charOffset = resolveNormalizedRangeStartOffset(renderedRange, normalizedCharacters);
  if (charOffset === null) return null;

  return {
    spineHref: spine.href,
    spineIndex: spine.index,
    charOffset,
  };
}
