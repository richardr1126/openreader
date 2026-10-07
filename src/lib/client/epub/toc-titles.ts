import type { NavItem } from 'epubjs';

import { epubHrefsMatch, type OutlineEntry } from '@/lib/client/reader/chapters';

/** Flatten an EPUB table of contents into depth-tagged outline entries, in reading order. */
export function epubTocOutline(toc: readonly NavItem[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const visit = (items: readonly NavItem[], depth: number) => {
    for (const item of items) {
      const label = item.label?.trim();
      if (label && item.href) entries.push({ title: label, target: { readerType: 'epub', href: item.href }, depth });
      if (item.subitems?.length) visit(item.subitems, depth + 1);
    }
  };
  visit(toc, 0);
  return entries;
}

/**
 * Maps an EPUB spine href to its first table-of-contents label. TOC hrefs are
 * relative to the navigation document while spine hrefs are relative to the
 * package, so paths are compared by suffix after dropping fragments.
 */
export function findEpubTocTitle(toc: readonly NavItem[], spineHref: string): string | null {
  for (const entry of epubTocOutline(toc)) {
    if (entry.target.readerType === 'epub' && epubHrefsMatch(entry.target.href, spineHref)) {
      return entry.title;
    }
  }
  return null;
}
