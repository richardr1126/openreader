'use client';

type RangeHighlight = {
  priority: number;
  readonly size: number;
  clear: () => void;
  add: (range: Range) => unknown;
  values: () => IterableIterator<AbstractRange>;
};

type HighlightRegistry = {
  get: (name: string) => RangeHighlight | undefined;
  set: (name: string, highlight: RangeHighlight) => void;
};

type HighlightWindow = Window & {
  Highlight?: new (...ranges: Range[]) => RangeHighlight;
  CSS: typeof CSS & { highlights?: HighlightRegistry };
};

function paintsExactly(highlight: RangeHighlight, range: Range): boolean {
  if (highlight.size !== 1) return false;
  const [painted] = highlight.values();
  return sameBoundaries(painted, range);
}

/**
 * Paint a DOM Range without wrapping or otherwise mutating its text nodes.
 * This is intentionally reader-agnostic and works in both the main document
 * and same-origin EPUB iframe documents. A higher `priority` paints above
 * overlapping highlights (the word layer over its segment).
 */
export function paintRangeHighlight(
  range: Range,
  name: string,
  declarations: string,
  priority = 0,
): boolean {
  const document = range.startContainer.nodeType === 9
    ? range.startContainer as Document
    : range.startContainer.ownerDocument;
  return document ? paintRangeHighlights(document, name, [range], declarations, priority) : false;
}

function sameBoundaries(a: AbstractRange, b: AbstractRange): boolean {
  return a.startContainer === b.startContainer
    && a.startOffset === b.startOffset
    && a.endContainer === b.endContainer
    && a.endOffset === b.endOffset;
}

function paintsExactlyAll(highlight: RangeHighlight, ranges: readonly Range[]): boolean {
  if (highlight.size !== ranges.length) return false;
  if (ranges.length === 1) return paintsExactly(highlight, ranges[0]);
  let index = 0;
  for (const painted of highlight.values()) {
    if (!sameBoundaries(painted, ranges[index])) return false;
    index += 1;
  }
  return true;
}

/**
 * Paint every range under one highlight name in a document, replacing what
 * that name painted before. An empty list clears it.
 */
export function paintRangeHighlights(
  document: Document,
  name: string,
  ranges: readonly Range[],
  declarations: string,
  priority = 0,
): boolean {
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

  // Register each highlight once and only ever update its ranges. Replacing
  // or unregistering a highlight leaves stale paint in WebKit (bugs 321567,
  // 266250), and every range mutation repaints, so unchanged ranges are left
  // alone rather than cleared and re-added.
  const existingHighlight = registry.get(name);
  if (existingHighlight) {
    if (existingHighlight.priority !== priority) existingHighlight.priority = priority;
    if (paintsExactlyAll(existingHighlight, ranges)) return true;
    existingHighlight.clear();
    for (const range of ranges) existingHighlight.add(range);
  } else {
    const highlight = new Highlight(...ranges);
    highlight.priority = priority;
    registry.set(name, highlight);
  }
  return true;
}

export function clearRangeHighlight(document: Document, name: string): void {
  const view = document.defaultView as HighlightWindow | null;
  const highlight = view?.CSS?.highlights?.get(name);
  // Keep the registration (see paintRangeHighlight); only drop its ranges.
  if (highlight && highlight.size > 0) highlight.clear();
}
