'use client';

type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => boolean;
};

type HighlightWindow = Window & {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS: typeof CSS & { highlights?: HighlightRegistry };
};

/**
 * Paint a DOM Range without wrapping or otherwise mutating its text nodes.
 * This is intentionally reader-agnostic and works in both the main document
 * and same-origin EPUB iframe documents.
 */
export function paintRangeHighlight(
  range: Range,
  name: string,
  declarations: string,
): boolean {
  const document = range.startContainer.nodeType === 9
    ? range.startContainer as Document
    : range.startContainer.ownerDocument;
  if (!document) return false;
  const view = document.defaultView as HighlightWindow | null;
  const registry = view?.CSS?.highlights;
  const Highlight = view?.Highlight;
  if (!registry || !Highlight) return false;

  const selector = `style[data-openreader-highlight="${name}"]`;
  const rule = `::highlight(${name}) { ${declarations} }`;
  const existingStyle = document.head.querySelector<HTMLStyleElement>(selector);
  if (existingStyle) {
    if (existingStyle.textContent !== rule) existingStyle.textContent = rule;
  } else {
    const style = document.createElement('style');
    style.dataset.openreaderHighlight = name;
    style.textContent = rule;
    document.head.appendChild(style);
  }

  registry.set(name, new Highlight(range));
  return true;
}

export function clearRangeHighlight(document: Document, name: string): void {
  const view = document.defaultView as HighlightWindow | null;
  view?.CSS?.highlights?.delete(name);
}
