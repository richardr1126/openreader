import { pdfjs } from 'react-pdf';
import { TextLayer } from 'pdfjs-dist';
import "core-js/proposals/promise-with-resolvers";
import type { TTSSentenceAlignment } from '@/types/tts';
import type { ParsedPdfDocument, ParsedPdfPage } from '@/types/parsed-pdf';
import type { TTSSegmentLocator } from '@/types/client';
import { segmentWords } from '@/lib/shared/language';
import {
  buildAlignmentTokenRanges,
  type HighlightTokenRange,
} from '@/lib/client/highlight-token-alignment';

// Worker coordination for offloading highlight token matching
interface HighlightTokenMatchRequest {
  id: string;
  type: 'tokenMatch';
  patternTokens: string[];
  tokenTexts: string[];
}

interface HighlightTokenMatchResponse {
  id: string;
  type: 'tokenMatchResult';
  bestStart: number;
  bestEnd: number;
  rating: number;
  lengthDiff: number;
}

let highlightWorker: Worker | null = null;

function getHighlightWorker(): Worker | null {
  if (typeof window === 'undefined') return null;
  if (highlightWorker) return highlightWorker;

  try {
    highlightWorker = new Worker(
      new URL('pdf-highlight-worker.ts', import.meta.url),
      { type: 'module' }
    );
    return highlightWorker;
  } catch (e) {
    console.error('Failed to initialize PDF highlight worker:', e);
    highlightWorker = null;
    return null;
  }
}

function runHighlightTokenMatch(
  patternTokens: string[],
  tokenTexts: string[]
): Promise<HighlightTokenMatchResponse | null> {
  const worker = getHighlightWorker();
  if (!worker) {
    return Promise.resolve(null);
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as HighlightTokenMatchResponse;
      if (!data || data.id !== id || data.type !== 'tokenMatchResult') {
        return;
      }
      worker.removeEventListener('message', handleMessage as EventListener);
      resolve(data);
    };

    worker.addEventListener('message', handleMessage as EventListener);

    const message: HighlightTokenMatchRequest = {
      id,
      type: 'tokenMatch',
      patternTokens,
      tokenTexts,
    };
    worker.postMessage(message);
  });
}

// Function to detect if we need to use legacy build
function shouldUseLegacyBuild() {
  try {
    if (typeof window === 'undefined') return false;

    const ua = window.navigator.userAgent;
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

    if (!isSafari) return false;

    // Extract Safari version - matches "Version/18" format
    const match = ua.match(/Version\/(\d+)/i);
    if (!match || !match[1]) return true; // If we can't determine version, use legacy to be safe

    const version = parseInt(match[1]);
    return version < 18; // Use legacy build for Safari versions equal or below 18
  } catch (e) {
    console.error('Error detecting Safari version:', e);
    return false;
  }
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
  useBlockGeometryOnly?: boolean;
  language?: string;
};

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

  let firstRect: { top: number; left: number } | null = null;
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
    highlight.style.position = 'absolute';
    highlight.style.backgroundColor = 'grey';
    highlight.style.opacity = '0.4';
    highlight.style.pointerEvents = 'none';
    highlight.style.zIndex = '1';
    highlight.style.left = `${left}px`;
    highlight.style.top = `${top}px`;
    highlight.style.width = `${width}px`;
    highlight.style.height = `${height}px`;
    layer.appendChild(highlight);

    if (!firstRect) {
      firstRect = { top: pageRect.top + top, left: pageRect.left + left };
    }
    drewAny = true;
  }

  if (!drewAny || !firstRect) return drewAny;

  const containerRect = container.getBoundingClientRect();
  const visibleTop = container.scrollTop;
  const visibleBottom = visibleTop + containerRect.height;
  const elementTop = firstRect.top - containerRect.top + container.scrollTop;

  if (elementTop < visibleTop || elementTop > visibleBottom) {
    container.scrollTo({
      top: elementTop - containerRect.height / 3,
      behavior: 'smooth',
    });
  }
  return true;
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
  text: string,
  pattern: string,
  containerRef: React.RefObject<HTMLDivElement>,
  options?: HighlightPatternOptions,
) {
  const seq = ++highlightPatternSeq;
  clearHighlights();

  if (!pattern?.trim()) return;
  const container = containerRef.current;
  if (!container) return;

  const cleanPattern = pattern.trim().replace(/\s+/g, ' ');
  if (!cleanPattern) return;
  lastSentencePattern = cleanPattern;
  lastSentenceWordToTokenRangeMap = null;
  lastSentenceTokenWindow = null;
  const parsedDocument = options?.parsedDocument ?? null;
  const locator = options?.locator ?? null;

  // Canonical path: parsed block locator is required for PDF sentence
  // highlighting. Avoid broad full-page text matching fallbacks.
  if (!parsedDocument || !locator || locator.readerType !== 'pdf' || !locator.blockId) {
    return;
  }

  const spanNodes = collectSpanNodesForParsedBlock(container, parsedDocument, locator) ?? [];

  if (!spanNodes.length) {
    if (options?.useBlockGeometryOnly) {
      highlightParsedBlockGeometry(containerRef, parsedDocument, locator);
    }
    return;
  }
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

  if (!tokens.length) return;
  lastTokens = tokens;

  if (options?.useBlockGeometryOnly) {
    lastSentenceTokenWindow = {
      start: 0,
      end: tokens.length - 1,
    };
    highlightParsedBlockGeometry(containerRef, parsedDocument, locator);
    return;
  }

  const patternLen = cleanPattern.length;

  // Core application of highlight logic once we know the best token window (if any)
  const applyHighlightFromTokens = (
    tokenMatch:
      | {
          bestStart: number;
          bestEnd: number;
          rating: number;
          lengthDiff: number;
        }
      | null
  ) => {
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

    if (!highlightRanges.length) return;

    // Create overlay rectangles for each range, relative to its page text layer
    const scrollIntoViewRects: DOMRect[] = [];

    highlightRanges.forEach(({ textNode, startOffset, endOffset, span }) => {
      try {
        const range = document.createRange();
        range.setStart(textNode, startOffset);
        range.setEnd(textNode, endOffset);

        const highlightTarget = getOrCreateHighlightLayer(span);
        if (!highlightTarget) return;

        const { layer: highlightLayer, pageRect } = highlightTarget;
        const rects = Array.from(range.getClientRects());

        rects.forEach((rect) => {
          const highlight = document.createElement('div');
          highlight.className = 'pdf-text-highlight-overlay';
          highlight.style.position = 'absolute';
          highlight.style.backgroundColor = 'grey';
          highlight.style.opacity = '0.4';
          highlight.style.pointerEvents = 'none';
          highlight.style.zIndex = '1';
          highlight.style.left = `${rect.left - pageRect.left}px`;
          highlight.style.top = `${rect.top - pageRect.top}px`;
          highlight.style.width = `${rect.width}px`;
          highlight.style.height = `${rect.height}px`;
          highlightLayer.appendChild(highlight);

          scrollIntoViewRects.push(rect);
        });
      } catch {
        // If range creation fails for any reason, skip this segment
      }
    });

    if (!scrollIntoViewRects.length) return;

    // Scroll the first highlighted rect into view if needed
    const containerRect = container.getBoundingClientRect();
    const visibleTop = container.scrollTop;
    const visibleBottom = visibleTop + containerRect.height;

    const firstRect = scrollIntoViewRects[0];
    const elementTop =
      firstRect.top - containerRect.top + container.scrollTop;

    if (elementTop < visibleTop || elementTop > visibleBottom) {
      container.scrollTo({
        top: elementTop - containerRect.height / 3,
        behavior: 'smooth',
      });
    }
  };

  const tokenTexts = tokens.map((t) => t.text);
  const patternTokens = segmentWords(cleanPattern, options?.language).map((token) => token.text);

  // Fire-and-forget async worker call; UI thread returns immediately
  runHighlightTokenMatch(patternTokens, tokenTexts)
    .then((result) => {
      if (seq !== highlightPatternSeq) return;
      if (!result || result.bestStart === -1) {
        // No worker result or no good match; nothing to highlight
        applyHighlightFromTokens(null);
      } else {
        applyHighlightFromTokens({
          bestStart: result.bestStart,
          bestEnd: result.bestEnd,
          rating: result.rating,
          lengthDiff: result.lengthDiff,
        });
      }
    })
    .catch((error) => {
      if (seq !== highlightPatternSeq) return;
      console.error(
        'Error in PDF highlight worker; no highlights applied:',
        error
      );
      applyHighlightFromTokens(null);
    });
}

export function highlightWordIndex(
  alignment: TTSSentenceAlignment | undefined,
  wordIndex: number | null | undefined,
  sentence: string | null | undefined,
  containerRef: React.RefObject<HTMLDivElement>
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

  for (let tokenIndex = tokenRange.start; tokenIndex <= tokenRange.end; tokenIndex += 1) {
    const token = lastTokens[tokenIndex];
    const span = lastSpanNodes[token.spanIndex];
    if (!span) continue;

    const node = token.textNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;

    try {
      const range = document.createRange();
      range.setStart(node, token.startOffset);
      range.setEnd(node, token.endOffset);

      const highlightTarget = getOrCreateHighlightLayer(span);
      if (!highlightTarget) continue;

      const { layer: highlightLayer, pageRect } = highlightTarget;
      const rects = Array.from(range.getClientRects());

      rects.forEach((rect) => {
        const highlight = document.createElement('div');
        highlight.className = 'pdf-word-highlight-overlay';
        highlight.style.position = 'absolute';
        highlight.style.backgroundColor = 'var(--accent)';
        highlight.style.opacity = '0.4';
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
