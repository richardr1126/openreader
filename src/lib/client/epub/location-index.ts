'use client';

import type { Book } from 'epubjs';
import type Section from 'epubjs/types/section';

import { normalizeMappedChars, type MappedChar } from '@/lib/client/highlight-char-map';
import type { TTSSegmentLocator } from '@/types/client';
import { isStableEpubLocator } from '@/types/client';

type DomPosition = {
  node: Text;
  offset: number;
};

type SectionLike = Section & {
  load?: ((request?: unknown) => Promise<Element | Document> | Element | Document) | undefined;
  unload?: () => void;
  cfiFromRange?: (range: Range) => string;
};

export type EpubWindowIndexEntry = {
  spineHref: string;
  spineIndex: number;
  startCfi: string;
  endCfi: string;
  startCharOffset: number;
  endCharOffset: number;
  startOrdinal: number;
  endOrdinal: number;
};

const WINDOW_INDEX = new WeakMap<Book, Map<string, EpubWindowIndexEntry[]>>();

const spineKey = (spineHref: string, spineIndex: number): string => `${spineIndex}:${spineHref}`;

const collectMappedText = (root: Element | Document): Array<MappedChar<DomPosition>> => {
  const isDocument = root.nodeType === Node.DOCUMENT_NODE;
  const doc = isDocument ? root as Document : root.ownerDocument;
  const body = isDocument
    ? (root as Document).body
    : (root as Element).querySelector?.('body') ?? root as Element;
  const mapped: Array<MappedChar<DomPosition>> = [];
  if (!doc || !body) return mapped;

  const nodeFilter = doc.defaultView?.NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(body, nodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const text = node.textContent ?? '';
    for (let offset = 0; offset < text.length; offset += 1) {
      mapped.push({ char: text[offset], pos: { node, offset } });
    }
    node = walker.nextNode() as Text | null;
  }
  return mapped;
};

const rangeFromPosition = (position: DomPosition): Range | null => {
  const doc = position.node.ownerDocument;
  if (!doc) return null;
  const range = doc.createRange();
  range.setStart(position.node, position.offset);
  range.setEnd(position.node, Math.min((position.node.textContent ?? '').length, position.offset + 1));
  return range;
};

export function registerEpubWindowIndexEntry(book: Book | null | undefined, entry: EpubWindowIndexEntry): void {
  if (!book?.isOpen) return;
  if (!entry.spineHref || entry.endCharOffset <= entry.startCharOffset) return;
  let bucket = WINDOW_INDEX.get(book);
  if (!bucket) {
    bucket = new Map();
    WINDOW_INDEX.set(book, bucket);
  }
  const key = spineKey(entry.spineHref, entry.spineIndex);
  const entries = bucket.get(key) ?? [];
  const next = entries.filter((existing) =>
    existing.startCharOffset !== entry.startCharOffset
    || existing.endCharOffset !== entry.endCharOffset
    || existing.startCfi !== entry.startCfi
  );
  next.push(entry);
  next.sort((a, b) => a.startCharOffset - b.startCharOffset || a.startOrdinal - b.startOrdinal);
  bucket.set(key, next);
}

export function clearEpubWindowIndex(book: Book | null | undefined): void {
  if (book) WINDOW_INDEX.delete(book);
}

export function findIndexedEpubWindowForLocator(
  book: Book | null | undefined,
  locator: TTSSegmentLocator | null | undefined,
): EpubWindowIndexEntry | null {
  if (!book?.isOpen || !isStableEpubLocator(locator)) return null;
  const bucket = WINDOW_INDEX.get(book);
  const entries = bucket?.get(spineKey(locator.spineHref, locator.spineIndex));
  if (!entries?.length) return null;
  const charOffset = Math.max(0, Math.floor(locator.charOffset));
  return entries.find((entry) =>
    charOffset >= entry.startCharOffset
    && charOffset < entry.endCharOffset
  ) ?? null;
}

export async function resolveEpubLocatorToCfi(
  book: Book | null | undefined,
  locator: TTSSegmentLocator | null | undefined,
): Promise<string | null> {
  if (!book?.isOpen || !isStableEpubLocator(locator)) return null;

  const indexed = findIndexedEpubWindowForLocator(book, locator);
  if (indexed) return indexed.startCfi;

  const section = book.spine.get(locator.spineHref as never) as SectionLike | undefined;
  if (!section || typeof section.load !== 'function' || typeof section.cfiFromRange !== 'function') {
    return typeof locator.cfi === 'string' && locator.cfi ? locator.cfi : null;
  }

  try {
    const loaded = await Promise.resolve(section.load(book.load.bind(book)));
    const normalized = normalizeMappedChars(collectMappedText(loaded));
    if (normalized.length === 0) return null;

    const target = Math.max(0, Math.min(Math.floor(locator.charOffset), normalized.length - 1));
    const mapped = normalized[target];
    if (!mapped) return null;
    const range = rangeFromPosition(mapped.pos);
    if (!range) return null;
    return section.cfiFromRange(range);
  } catch {
    return typeof locator.cfi === 'string' && locator.cfi ? locator.cfi : null;
  } finally {
    try {
      section.unload?.();
    } catch {
      // no-op
    }
  }
}
