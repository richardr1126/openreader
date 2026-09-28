import type { NavItem } from 'epubjs';

function normalizeHref(href: string): string {
  const path = href.split('#')[0] ?? '';
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the raw path when the EPUB contains malformed escapes.
  }
  return decoded.replace(/^(\.\.\/|\.\/|\/)+/, '');
}

/**
 * Maps an EPUB spine href to its first table-of-contents label. TOC hrefs are
 * relative to the navigation document while spine hrefs are relative to the
 * package, so paths are compared by suffix after dropping fragments.
 */
export function findEpubTocTitle(toc: readonly NavItem[], spineHref: string): string | null {
  const target = normalizeHref(spineHref);
  if (!target) return null;
  const stack = [...toc];
  while (stack.length > 0) {
    const item = stack.shift()!;
    const href = normalizeHref(item.href ?? '');
    const label = item.label?.trim();
    if (label && href && (href === target || target.endsWith(`/${href}`) || href.endsWith(`/${target}`))) {
      return label;
    }
    if (item.subitems?.length) stack.unshift(...item.subitems);
  }
  return null;
}
