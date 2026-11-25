import { pdfjs } from 'react-pdf';
import { TextLayer } from 'pdfjs-dist';
import "core-js/proposals/promise-with-resolvers";
import type { TTSSentenceAlignment } from '@/types/tts';
import type { ParsedPdfDocument, ParsedPdfPage } from '@/types/parsed-pdf';
import type { TTSSegmentLocator } from '@/types/client';
import { segmentWords } from '@openreader/tts/language';
import {
  buildAlignmentTokenRanges,
  findBestHighlightTokenMatch,
  type HighlightTokenRange,
} from '@/lib/client/highlight-token-alignment';

export function shouldUseLegacyPdfBuild(userAgent: string): boolean {
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  if (!isSafari) return false;

  const match = userAgent.match(/Version\/(\d+)/i);
  if (!match?.[1]) return true;
  return Number.parseInt(match[1], 10) <= 18;
}

function shouldUseLegacyBuild(): boolean {
  if (typeof window === 'undefined') return false;
  return shouldUseLegacyPdfBuild(window.navigator.userAgent);
}

// Function to initialize PDF worker
function initPDFWorker() {
  try {
    if (typeof window !== 'undefined') {
      const useLegacy = shouldUseLegacyBuild();
      // Use local worker file instead of unpkg
      const workerSrc = useLegacy
        ? new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href
        : new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      pdfjs.GlobalWorkerOptions.workerPort = null;
    }
  } catch (e) {
    console.error('Error setting PDF worker:', e);
  }
}

// Initialize the worker
initPDFWorker();

// Patch TextLayer.render to treat cancelled renders as non-errors
try {
  const textLayerProto = TextLayer?.prototype;
  const originalRender = textLayerProto?.render;
  if (typeof originalRender === 'function') {
    textLayerProto.render = async function patchedRender(...args) {
      const task = originalRender.apply(this, args);
      if (!task || typeof task.then !== 'function') return task;
      return task.catch((error) => {
        if (error && (error.name === 'AbortException' || error.name === 'RenderingCancelledException')) {
          return;
        }
        throw error;
      });
    };
  }
} catch (e) {
  console.error('Error patching TextLayer.render:', e);
}

type PDFToken = {
  spanIndex: number;
  textNode: Text;
  text: string;
  startOffset: number;
  endOffset: number;
};

let lastSpanNodes: HTMLElement[] = [];
let lastTokens: PDFToken[] = [];
let lastSentenceTokenWindow: { start: number; end: number } | null = null;
let lastSentencePattern: string | null = null;
let lastSentenceWordToTokenRangeMap: Array<HighlightTokenRange | null> | null = null;

function getOrCreateHighlightLayer(span: HTMLElement): {
  layer: HTMLElement;
  pageElement: HTMLElement;
  pageRect: DOMRect;
} | null {
  const pageElement = span.closest('.react-pdf__Page') as HTMLElement | null;
  if (!pageElement) return null;

  let layer = pageElement.querySelector('.pdf-highlight-layer') as HTMLElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'pdf-highlight-layer';
    pageElement.appendChild(layer);
  }

  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.pointerEvents = 'none';
  layer.style.zIndex = '4';
  layer.style.overflow = 'hidden';
  // Force a compositor layer to avoid Safari occasionally not painting
  // newly-added positioned overlays.
  layer.style.transform = 'translateZ(0)';

  return { layer, pageElement, pageRect: pageElement.getBoundingClientRect() };
}

// Highlighting functions
let highlightPatternSeq = 0;

type HighlightPatternOptions = {
  parsedDocument?: ParsedPdfDocument | null;
  locator?: TTSSegmentLocator | null;
  paintSegment?: boolean;
  useBlockGeometryOnly?: boolean;
  language?: string;
  follow?: boolean;
  preferWord?: boolean;
};

type HighlightRect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

function followHighlight(container: HTMLElement, rects: readonly HighlightRect[]): void {
  const first = rects[0];
  const { clientHeight, clientWidth, scrollTop, scrollLeft } = container;
  if (!first || !clientHeight || !clientWidth) return;

  const viewport = container.getBoundingClientRect();
  const top = viewport.top + container.clientTop;
  const left = viewport.left + container.clientLeft;
  const bottom = top + clientHeight;
  const right = left + clientWidth;
  let { top: targetTop, bottom: targetBottom, left: targetLeft, right: targetRight } = first;
  for (const rect of rects) {
    targetTop = Math.min(targetTop, rect.top);
    targetBottom = Math.max(targetBottom, rect.bottom);
    targetLeft = Math.min(targetLeft, rect.left);
    targetRight = Math.max(targetRight, rect.right);
  }
  // With an oversized segment, use the first line as the fallback anchor.
  if (targetBottom - targetTop > clientHeight) {
    targetTop = first.top;
    targetBottom = first.bottom;
  }
  if (targetRight - targetLeft > clientWidth) {
    targetLeft = first.left;
    targetRight = Math.min(first.right, first.left + clientWidth);
  }

  // Allow for fractional range coordinates and integer scroll positions.
  const outsideVertically = targetTop < top - 1 || targetBottom > bottom + 1;
  const outsideHorizontally = targetLeft < left - 1 || targetRight > right + 1;
  if (!outsideVertically && !outsideHorizontally) return;

  // Leave room for subsequent lines and avoid restarting a scroll animation
  // as more words arrive or the user starts browsing.
  const verticalInset = Math.max(0, Math.min(clientHeight / 3, (clientHeight - (targetBottom - targetTop)) / 2));
  const nextTop = outsideVertically ? scrollTop + targetTop - top - verticalInset : scrollTop;
  const nextLeft = outsideHorizontally
    ? scrollLeft + (targetLeft < left ? targetLeft - left : targetRight - right)
    : scrollLeft;
  container.scrollTo({ top: nextTop, left: nextLeft, behavior: 'instant' });
}

function getHighlightLayerForPage(pageElement: HTMLElement): {
  layer: HTMLElement;
  pageRect: DOMRect;
} {
  let layer = pageElement.querySelector('.pdf-highlight-layer') as HTMLElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'pdf-highlight-layer';
    pageElement.appendChild(layer);
  }

  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.pointerEvents = 'none';
  layer.style.zIndex = '4';
  layer.style.overflow = 'hidden';
  layer.style.transform = 'translateZ(0)';

  return { layer, pageRect: pageElement.getBoundingClientRect() };
}

function findRenderedPageElement(container: HTMLElement, pageNumber: number): HTMLElement | null {
  const direct = container.querySelector(`.react-pdf__Page[data-page-number="${pageNumber}"]`) as HTMLElement | null;
  if (direct) return direct;

  const pageNodes = Array.from(container.querySelectorAll('.react-pdf__Page')) as HTMLElement[];
  for (const pageNode of pageNodes) {
    const attr = pageNode.getAttribute('data-page-number');
    if (Number(attr) === pageNumber) return pageNode;
  }
  return null;
}

function highlightParsedBlockGeometry(
  containerRef: React.RefObject<HTMLDivElement>,
  parsedDocument: ParsedPdfDocument,
  locator: TTSSegmentLocator,
  follow = true,
): boolean {
  if (locator.readerType !== 'pdf') return false;
  if (!locator.blockId) return false;
  const container = containerRef.current;
  if (!container) return false;

  let targetBlock:
    | ParsedPdfPage['blocks'][number]
    | null = null;
  for (const page of parsedDocument.pages) {
    const found = page.blocks.find((block) => block.id === locator.blockId);
    if (found) {
      targetBlock = found;
      break;
    }
  }
  if (!targetBlock) return false;

  let followRect: HighlightRect | null = null;
  let drewAny = false;

  for (const fragment of targetBlock.fragments) {
    const parsedPage = parsedDocument.pages.find((page) => page.pageNumber === fragment.page);
    if (!parsedPage || parsedPage.width <= 0 || parsedPage.height <= 0) continue;

    const pageElement = findRenderedPageElement(container, fragment.page);
    if (!pageElement) continue;

    const { layer, pageRect } = getHighlightLayerForPage(pageElement);
    const [x0, y0, x1, y1] = fragment.bbox;
    const left = (x0 / parsedPage.width) * pageRect.width;
    const top = (y0 / parsedPage.height) * pageRect.height;
    const width = ((x1 - x0) / parsedPage.width) * pageRect.width;
    const height = ((y1 - y0) / parsedPage.height) * pageRect.height;

    if (!(width > 0 && height > 0)) continue;

    const highlight = document.createElement('div');
    highlight.className = 'pdf-text-highlight-overlay';
    highlight.dataset.testid = 'pdf-sentence-highlight';
    highlight.style.position = 'absolute';
    highlight.style.backgroundColor = 'var(--reader-segment-color, grey)';
    highlight.style.opacity = 'var(--reader-segment-opacity, 0.4)';
    highlight.style.pointerEvents = 'none';
    highlight.style.zIndex = '1';
    highlight.style.left = `${left}px`;
    highlight.style.top = `${top}px`;
    highlight.style.width = `${width}px`;
    highlight.style.height = `${height}px`;
    layer.appendChild(highlight);

    if (!followRect || fragment.page === locator.page) {
      followRect = {
        top: pageRect.top + top,
        bottom: pageRect.top + top + height,
        left: pageRect.left + left,
        right: pageRect.left + left + width,
      };
    }
    drewAny = true;
  }

  if (followRect && follow) followHighlight(container, [followRect]);
  return drewAny;
}

function resolveParsedBlock(
  parsedDocument: ParsedPdfDocument | null | undefined,
  locator: TTSSegmentLocator | null | undefined,
): ParsedPdfPage['blocks'][number] | null {
  if (!parsedDocument || !locator || locator.readerType !== 'pdf' || !locator.blockId) {
    return null;
  }

  for (const page of parsedDocument.pages) {
    const found = page.blocks.find((block) => block.id === locator.blockId);
    if (found) return found;
  }
  return null;
}

function isRectOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function collectSpanNodesForParsedBlock(
  container: HTMLElement,
  parsedDocument: ParsedPdfDocument,
  locator: TTSSegmentLocator,
): HTMLElement[] | null {
  const block = resolveParsedBlock(parsedDocument, locator);
  if (!block) return null;

  const collected: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const fragment of block.fragments) {
    const parsedPage = parsedDocument.pages.find((page) => page.pageNumber === fragment.page);
    if (!parsedPage || parsedPage.width <= 0 || parsedPage.height <= 0) continue;

    const pageElement = findRenderedPageElement(container, fragment.page);
    if (!pageElement) continue;

    const textLayer = pageElement.querySelector('.react-pdf__Page__textContent') as HTMLElement | null;
    if (!textLayer) continue;

    const pageRect = pageElement.getBoundingClientRect();
    const [x0, y0, x1, y1] = fragment.bbox;
    const blockRect = {
      left: (x0 / parsedPage.width) * pageRect.width,
      top: (y0 / parsedPage.height) * pageRect.height,
      right: (x1 / parsedPage.width) * pageRect.width,
      bottom: (y1 / parsedPage.height) * pageRect.height,
    };

    const spans = Array.from(textLayer.querySelectorAll('span')) as HTMLElement[];
    for (const span of spans) {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;

      const rect = span.getBoundingClientRect();
      const spanRect = {
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
      };

      if (!isRectOverlap(spanRect, blockRect)) continue;
      if (seen.has(span)) continue;
      seen.add(span);
      collected.push(span);
    }
  }

  return collected.length > 0 ? collected : null;
}

/** The text-layer spans rendering one parsed block, keyed `pdf:<page>:<blockId>`. */
export function pdfBlockSpans(
  container: HTMLElement,
  parsedDocument: ParsedPdfDocument,
  sourceKey: string,
): HTMLElement[] | null {
  const match = /^pdf:(\d+):(.+)$/u.exec(sourceKey);
  if (!match) return null;
  return collectSpanNodesForParsedBlock(container, parsedDocument, {
    readerType: 'pdf',
    page: Number(match[1]),
    blockId: match[2],
  });
}

/**
 * The parsed block under a viewport point, with the text-layer spans that
 * render it. Blocks are plan source units keyed `pdf:<page>:<blockId>`, so
 * this is the unit tap-to-seek resolves a sentence within.
 */
export function resolvePdfBlockAtPoint(
  container: HTMLElement,
  parsedDocument: ParsedPdfDocument,
  point: { clientX: number; clientY: number; target: EventTarget | null },
): { sourceKey: string; spans: HTMLElement[] } | null {
  const target = point.target as Element | null;
  const pageElement = target?.closest?.('.react-pdf__Page') as HTMLElement | null;
  if (!pageElement || !container.contains(pageElement)) return null;
  const pageNumber = Number(pageElement.getAttribute('data-page-number'));
  if (!Number.isFinite(pageNumber)) return null;
  const pageRect = pageElement.getBoundingClientRect();
  if (!(pageRect.width > 0 && pageRect.height > 0)) return null;

  for (const page of parsedDocument.pages) {
    for (const block of page.blocks) {
      const hit = block.fragments.some((fragment) => {
        if (fragment.page !== pageNumber) return false;
        const fragmentPage = parsedDocument.pages.find((candidate) => candidate.pageNumber === fragment.page);
        if (!fragmentPage || fragmentPage.width <= 0 || fragmentPage.height <= 0) return false;
        const x = ((point.clientX - pageRect.left) / pageRect.width) * fragmentPage.width;
        const y = ((point.clientY - pageRect.top) / pageRect.height) * fragmentPage.height;
        const [x0, y0, x1, y1] = fragment.bbox;
        return x >= x0 && x <= x1 && y >= y0 && y <= y1;
      });
      if (!hit) continue;
      const locator: TTSSegmentLocator = { readerType: 'pdf', page: page.pageNumber, blockId: block.id };
      const spans = collectSpanNodesForParsedBlock(container, parsedDocument, locator);
      return spans ? { sourceKey: `pdf:${page.pageNumber}:${block.id}`, spans } : null;
    }
  }
  return null;
}

export function clearHighlights() {
  const overlays = document.querySelectorAll('.pdf-text-highlight-overlay');
  overlays.forEach((node) => {
    const element = node as HTMLElement;
    if (element.parentElement) {
      element.parentElement.removeChild(element);
    }
  });
  const wordOverlays = document.querySelectorAll('.pdf-word-highlight-overlay');
  wordOverlays.forEach((node) => {
    const element = node as HTMLElement;
    if (element.parentElement) {
      element.parentElement.removeChild(element);
    }
  });
}

export function clearWordHighlights() {
  const wordOverlays = document.querySelectorAll('.pdf-word-highlight-overlay');
  wordOverlays.forEach((node) => {
    const element = node as HTMLElement;
    if (element.parentElement) {
      element.parentElement.removeChild(element);
    }
  });
}

export function highlightPattern(
  pattern: string,
  containerRef: React.RefObject<HTMLDivElement>,
  options?: HighlightPatternOptions,
): boolean {
  const seq = ++highlightPatternSeq;
  clearHighlights();
  lastSentencePattern = null;
  lastSentenceWordToTokenRangeMap = null;
  lastSentenceTokenWindow = null;
  lastSpanNodes = [];
  lastTokens = [];

  if (!pattern?.trim()) return false;
  const container = containerRef.current;
  if (!container) return false;

  const cleanPattern = pattern.trim().replace(/\s+/g, ' ');
  if (!cleanPattern) return false;
  lastSentencePattern = cleanPattern;
  const parsedDocument = options?.parsedDocument ?? null;
  const locator = options?.locator ?? null;
  const paintSegment = options?.paintSegment ?? true;
  const useBlockGeometryOnly = paintSegment && options?.useBlockGeometryOnly;

  // Canonical path: parsed block locator is required for PDF sentence
  // highlighting. Avoid broad full-page text matching fallbacks.
  if (!parsedDocument || !locator || locator.readerType !== 'pdf' || !locator.blockId) {
    return false;
  }

  const spanNodes = collectSpanNodesForParsedBlock(container, parsedDocument, locator) ?? [];
  lastSpanNodes = spanNodes;

  const tokens: PDFToken[] = [];

  spanNodes.forEach((span, spanIndex) => {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;

    const textNode = node as Text;
    const textContent = textNode.textContent || '';
    for (const token of segmentWords(textContent, options?.language)) {
      tokens.push({
        spanIndex,
        textNode,
        text: token.text,
        startOffset: token.start,
        endOffset: token.end,
      });
    }
  });

  lastTokens = tokens;
  if (!tokens.length) {
    return Boolean(useBlockGeometryOnly
      && highlightParsedBlockGeometry(containerRef, parsedDocument, locator, options?.follow));
  }

  const patternLen = cleanPattern.length;

  // Resolve the segment's text ranges for readiness, scrolling, and word mapping.
  // Segment background painting is optional and never owns that preparation.
  const applyHighlightFromTokens = (
    tokenMatch:
      | {
          bestStart: number;
          bestEnd: number;
          rating: number;
          lengthDiff: number;
        }
      | null
  ): boolean => {
    const highlightRanges: Array<{
      textNode: Text;
      startOffset: number;
      endOffset: number;
      span: HTMLElement;
    }> = [];

    let bestStart = -1;
    let bestEnd = -1;
    let bestRating = 0;
    let bestLengthDiff = Infinity;

    if (tokenMatch) {
      bestStart = tokenMatch.bestStart;
      bestEnd = tokenMatch.bestEnd;
      bestRating = tokenMatch.rating;
      bestLengthDiff = tokenMatch.lengthDiff;
    }

    const hasTokenMatch = bestStart !== -1;
    const similarityThreshold =
      bestLengthDiff < patternLen * 0.3 ? 0.3 : 0.5;

    if (hasTokenMatch && bestRating >= similarityThreshold) {
      lastSentenceTokenWindow = {
        start: bestStart,
        end: bestEnd,
      };

      const rangesBySpan = new Map<
        number,
        { startOffset: number; endOffset: number }
      >();

      for (let i = bestStart; i <= bestEnd; i++) {
        const token = tokens[i];
        const existing = rangesBySpan.get(token.spanIndex);
        if (!existing) {
          rangesBySpan.set(token.spanIndex, {
            startOffset: token.startOffset,
            endOffset: token.endOffset,
          });
        } else {
          existing.startOffset = Math.min(
            existing.startOffset,
            token.startOffset
          );
          existing.endOffset = Math.max(
            existing.endOffset,
            token.endOffset
          );
        }
      }

      rangesBySpan.forEach(({ startOffset, endOffset }, spanIndex) => {
        const span = spanNodes[spanIndex];
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return;

        highlightRanges.push({
          textNode: node as Text,
          startOffset,
          endOffset,
          span,
        });
      });
    }

    // Create overlay rectangles for each range, relative to its page text layer
    const scrollIntoViewRects: DOMRect[] = [];

    highlightRanges.forEach(({ textNode, startOffset, endOffset, span }) => {
      try {
        const range = document.createRange();
        range.setStart(textNode, startOffset);
        range.setEnd(textNode, endOffset);

        const rects = Array.from(range.getClientRects());
        scrollIntoViewRects.push(...rects);
        if (!paintSegment || useBlockGeometryOnly) return;

        const highlightTarget = getOrCreateHighlightLayer(span);
        if (!highlightTarget) return;
        const { layer: highlightLayer, pageRect } = highlightTarget;

        rects.forEach((rect) => {
          const highlight = document.createElement('div');
          highlight.className = 'pdf-text-highlight-overlay';
          highlight.dataset.testid = 'pdf-sentence-highlight';
          highlight.style.position = 'absolute';
          highlight.style.backgroundColor = 'var(--reader-segment-color, grey)';
          highlight.style.opacity = 'var(--reader-segment-opacity, 0.4)';
          highlight.style.pointerEvents = 'none';
          highlight.style.zIndex = '1';
          highlight.style.left = `${rect.left - pageRect.left}px`;
          highlight.style.top = `${rect.top - pageRect.top}px`;
          highlight.style.width = `${rect.width}px`;
          highlight.style.height = `${rect.height}px`;
          highlightLayer.appendChild(highlight);
        });
      } catch {
        // If range creation fails for any reason, skip this segment
      }
    });

    const follow = options?.follow !== false;
    if (follow && !options?.preferWord) followHighlight(container, scrollIntoViewRects);
    if (useBlockGeometryOnly) {
      return highlightParsedBlockGeometry(containerRef, parsedDocument, locator, follow && !scrollIntoViewRects.length);
    }
    return scrollIntoViewRects.length > 0;
  };

  const tokenTexts = tokens.map((t) => t.text);
  const patternTokens = segmentWords(cleanPattern, options?.language).map((token) => token.text);

  const result = findBestHighlightTokenMatch(patternTokens, tokenTexts);
  if (seq !== highlightPatternSeq || result.start === -1) {
    return applyHighlightFromTokens(null);
  }
  return applyHighlightFromTokens({
    bestStart: result.start,
    bestEnd: result.end,
    rating: result.rating,
    lengthDiff: result.lengthDiff,
  });
}

export function highlightWordIndex(
  alignment: TTSSentenceAlignment | undefined,
  wordIndex: number | null | undefined,
  sentence: string | null | undefined,
  containerRef: React.RefObject<HTMLDivElement>,
  { follow = false, paintWord = true }: { follow?: boolean; paintWord?: boolean } = {},
) {
  clearWordHighlights();

  if (!alignment) return;
  if (wordIndex === null || wordIndex === undefined || wordIndex < 0) {
    return;
  }

  const words = alignment.words || [];
  if (!words.length || wordIndex >= words.length) return;

  const container = containerRef.current;
  if (!container) return;
  if (!lastSentenceTokenWindow) return;
  if (!lastTokens.length || !lastSpanNodes.length) return;

  const cleanSentence =
    sentence && sentence.trim()
      ? sentence.trim().replace(/\s+/g, ' ')
      : null;
  if (!cleanSentence || !lastSentencePattern) return;
  if (cleanSentence !== lastSentencePattern) return;

  const start = lastSentenceTokenWindow.start;
  const end = lastSentenceTokenWindow.end;
  if (end < start) return;

  // Lazily build or refresh the shared mapping from alignment words to PDF
  // token ranges for this sentence window.
  if (
    !lastSentenceWordToTokenRangeMap ||
    lastSentenceWordToTokenRangeMap.length !== words.length
  ) {
    const relativeRanges = buildAlignmentTokenRanges(
      words,
      lastTokens.slice(start, end + 1).map((token) => token.text),
      { fillGaps: true },
    );
    lastSentenceWordToTokenRangeMap = relativeRanges.map((range) => (
      range ? { start: range.start + start, end: range.end + start } : null
    ));
  }

  const tokenRange = lastSentenceWordToTokenRangeMap[wordIndex];
  if (!tokenRange) return;

  const wordRects: DOMRect[] = [];
  for (let tokenIndex = tokenRange.start; tokenIndex <= tokenRange.end; tokenIndex += 1) {
    const token = lastTokens[tokenIndex];
    const span = lastSpanNodes[token.spanIndex];
    if (!span || !container.contains(span)) continue;

    const node = token.textNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;

    try {
      const range = document.createRange();
      range.setStart(node, token.startOffset);
      range.setEnd(node, token.endOffset);
      const rects = Array.from(range.getClientRects());
      if (follow) wordRects.push(...rects);
      if (!paintWord) continue;

      const highlightTarget = getOrCreateHighlightLayer(span);
      if (!highlightTarget) continue;

      const { layer: highlightLayer, pageRect } = highlightTarget;
      rects.forEach((rect) => {
        const highlight = document.createElement('div');
        highlight.className = 'pdf-word-highlight-overlay';
        highlight.style.position = 'absolute';
        highlight.style.backgroundColor = 'var(--reader-word-color, var(--accent))';
        highlight.style.opacity = 'var(--reader-word-opacity, 0.4)';
        highlight.style.pointerEvents = 'none';
        highlight.style.left = `${rect.left - pageRect.left}px`;
        highlight.style.top = `${rect.top - pageRect.top}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
        highlight.style.zIndex = '2';
        highlightLayer.appendChild(highlight);
      });
    } catch {
      // Ignore range errors
    }
  }
  if (follow) followHighlight(container, wordRects);
}

// Debounce for PDF viewer
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
