import { pdfjs } from 'react-pdf';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { type PDFDocumentProxy, TextLayer } from 'pdfjs-dist';
import "core-js/proposals/promise-with-resolvers";
import type { TTSSentenceAlignment } from '@/types/tts';
import { CmpStr } from 'cmpstr';

const cmp = CmpStr.create().setMetric('dice').setFlags('itw');

// Worker coordination for offloading highlight token matching
interface HighlightTokenMatchRequest {
  id: string;
  type: 'tokenMatch';
  pattern: string;
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
  pattern: string,
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
      pattern,
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
    
    console.log(isSafari ? 'Running on Safari' : 'Not running on Safari');
    if (!isSafari) return false;
    
    // Extract Safari version - matches "Version/18" format
    const match = ua.match(/Version\/(\d+)/i);
    console.log('Safari version:', match);
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
      console.log('Setting PDF worker to:', workerSrc);
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
let lastSentenceWordToTokenMap: number[] | null = null;

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

const normalizeWordForMatch = (text: string): string =>
  text
    .trim()
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .toLowerCase();

// Text Processing functions
export async function extractTextFromPDF(
  pdf: PDFDocumentProxy, 
  pageNumber: number, 
  margins = { header: 0.07, footer: 0.07, left: 0.07, right: 0.07 }
): Promise<string> {
  try {
    // Log pdf worker version
    //console.log('PDF worker version:', pdfjs.GlobalWorkerOptions.workerSrc);

    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;
    const pageWidth = viewport.width;

    const textItems = textContent.items.filter((item): item is TextItem => {
      if (!('str' in item && 'transform' in item)) return false;
      
      const [scaleX, skewX, skewY, scaleY, x, y] = item.transform;
      
      // Basic text filtering
      if (Math.abs(scaleX) < 1 || Math.abs(scaleX) > 20) return false;
      if (Math.abs(scaleY) < 1 || Math.abs(scaleY) > 20) return false;
      if (Math.abs(skewX) > 0.5 || Math.abs(skewY) > 0.5) return false;
      
      // Calculate margins in PDF coordinate space (y=0 is at bottom)
      const headerY = pageHeight * (1 - margins.header); // Convert from top margin to bottom-based Y
      const footerY = pageHeight * margins.footer; // Footer Y stays as is since it's already bottom-based
      const leftX = pageWidth * margins.left;
      const rightX = pageWidth * (1 - margins.right);
      
      // Check margins - remember y=0 is at bottom of page in PDF coordinates
      if (y > headerY || y < footerY) { // Y greater than headerY means it's in header area, less than footerY means footer area
        return false;
      }

      // Check horizontal margins
      if (x < leftX || x > rightX) {
        return false;
      }
      
      // Sanity check for coordinates
      if (x < 0 || x > pageWidth) return false;
      
      return item.str.trim().length > 0;
    });

    //console.log('Filtered text items:', textItems);

    const tolerance = 2;
    const lines: TextItem[][] = [];
    let currentLine: TextItem[] = [];
    let currentY: number | null = null;

    textItems.forEach((item) => {
      const y = item.transform[5];
      if (currentY === null) {
        currentY = y;
        currentLine.push(item);
      } else if (Math.abs(y - currentY) < tolerance) {
        currentLine.push(item);
      } else {
        lines.push(currentLine);
        currentLine = [item];
        currentY = y;
      }
    });
    lines.push(currentLine);

    let pageText = '';
    for (const line of lines) {
      line.sort((a, b) => a.transform[4] - b.transform[4]);
      let lineText = '';
      let prevItem: TextItem | null = null;

      for (const item of line) {
        if (!prevItem) {
          lineText = item.str;
        } else {
          const prevEndX = prevItem.transform[4] + (prevItem.width ?? 0);
          const currentStartX = item.transform[4];
          const space = currentStartX - prevEndX;
          
          // Get average character width as fallback
          const avgCharWidth = (item.width ?? 0) / Math.max(1, item.str.length);
          
          // Multiple conditions for space detection
          const needsSpace = 
              // Primary check: significant gap between items
              space > Math.max(avgCharWidth * 0.3, 2) ||
              // Secondary check: natural word boundary
              (!/^\W/.test(item.str) && !/\W$/.test(prevItem.str)) ||
              // Tertiary check: items are far enough apart relative to their size
              (space > ((prevItem.width ?? 0) * 0.25));

          if (needsSpace) {
              lineText += ' ' + item.str;
          } else {
              lineText += item.str;
          }
        }
        prevItem = item;
      }
      pageText += lineText + ' ';
    }

    return pageText.replace(/\s+/g, ' ').trim();
  } catch (error) {
    // During Next.js fast refresh / route transitions, react-pdf can tear down the
    // underlying worker and pdf.js may throw a TypeError like:
    // "null is not an object (evaluating 'this.messageHandler.sendWithPromise')".
    // Treat this as a cancellation so the app can ignore it.
    if (
      error instanceof TypeError &&
      typeof error.message === 'string' &&
      error.message.includes('messageHandler') &&
      error.message.includes('sendWithPromise')
    ) {
      throw new DOMException('PDF worker torn down', 'AbortError');
    }

    console.error('Error extracting text from PDF:', error);
    // Preserve the original error so callers can decide whether to retry/ignore.
    throw error;
  }
}

// Highlighting functions
let highlightPatternSeq = 0;

export function clearHighlights() {
  const textNodes = document.querySelectorAll('.react-pdf__Page__textContent span');
  textNodes.forEach((node) => {
    const element = node as HTMLElement;
    element.style.backgroundColor = '';
    element.style.opacity = '1';
  });

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
  containerRef: React.RefObject<HTMLDivElement>
) {
  const seq = ++highlightPatternSeq;
  clearHighlights();

  if (!pattern?.trim()) return;
  const container = containerRef.current;
  if (!container) return;

  const cleanPattern = pattern.trim().replace(/\s+/g, ' ');
  if (!cleanPattern) return;
  lastSentencePattern = cleanPattern;
  lastSentenceWordToTokenMap = null;
  lastSentenceTokenWindow = null;

  const spanNodes = Array.from(
    container.querySelectorAll('.react-pdf__Page__textContent span')
  ) as HTMLElement[];

  if (!spanNodes.length) return;
  lastSpanNodes = spanNodes;

  const tokens: PDFToken[] = [];

  spanNodes.forEach((span, spanIndex) => {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;

    const textNode = node as Text;
    const textContent = textNode.textContent || '';
    const wordRegex = /\S+/g;
    let match: RegExpExecArray | null;

    while ((match = wordRegex.exec(textContent)) !== null) {
      const word = match[0];
      tokens.push({
        spanIndex,
        textNode,
        text: word,
        startOffset: match.index,
        endOffset: match.index + word.length,
      });
    }
  });

  if (!tokens.length) return;
  lastTokens = tokens;

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

  // Fire-and-forget async worker call; UI thread returns immediately
  runHighlightTokenMatch(cleanPattern, tokenTexts)
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

  // Lazily build or refresh the mapping from alignment word
  // indices to PDF token indices for this sentence window.
  if (
    !lastSentenceWordToTokenMap ||
    lastSentenceWordToTokenMap.length !== words.length
  ) {
    const pdfFiltered: { tokenIndex: number; norm: string }[] = [];
    for (let i = start; i <= end; i++) {
      const norm = normalizeWordForMatch(lastTokens[i].text);
      if (!norm) continue;
      pdfFiltered.push({ tokenIndex: i, norm });
    }

    const ttsFiltered: { wordIndex: number; norm: string }[] = [];
    for (let i = 0; i < words.length; i++) {
      const norm = normalizeWordForMatch(words[i].text);
      if (!norm) continue;
      ttsFiltered.push({ wordIndex: i, norm });
    }

    const wordToToken = new Array<number>(words.length).fill(-1);

    const m = pdfFiltered.length;
    const n = ttsFiltered.length;

    if (m && n) {
      const dp: number[][] = Array.from({ length: m + 1 }, () =>
        new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY)
      );
      const bt: number[][] = Array.from({ length: m + 1 }, () =>
        new Array<number>(n + 1).fill(0)
      ); // 0=diag,1=up,2=left

      dp[0][0] = 0;
      const GAP_COST = 0.7;

      for (let i = 0; i <= m; i++) {
        for (let j = 0; j <= n; j++) {
          if (i > 0 && j > 0) {
            const a = pdfFiltered[i - 1].norm;
            const b = ttsFiltered[j - 1].norm;
            const sim = cmp.compare(a, b);
            const subCost = 1 - sim;
            const cand = dp[i - 1][j - 1] + subCost;
            if (cand < dp[i][j]) {
              dp[i][j] = cand;
              bt[i][j] = 0;
            }
          }
          if (i > 0) {
            const cand = dp[i - 1][j] + GAP_COST;
            if (cand < dp[i][j]) {
              dp[i][j] = cand;
              bt[i][j] = 1;
            }
          }
          if (j > 0) {
            const cand = dp[i][j - 1] + GAP_COST;
            if (cand < dp[i][j]) {
              dp[i][j] = cand;
              bt[i][j] = 2;
            }
          }
        }
      }

      let i = m;
      let j = n;
      while (i > 0 || j > 0) {
        const move = bt[i][j];
        if (i > 0 && j > 0 && move === 0) {
          const pdfIdx = pdfFiltered[i - 1].tokenIndex;
          const ttsIdx = ttsFiltered[j - 1].wordIndex;
          if (wordToToken[ttsIdx] === -1) {
            wordToToken[ttsIdx] = pdfIdx;
          }
          i -= 1;
          j -= 1;
        } else if (i > 0 && (move === 1 || j === 0)) {
          i -= 1;
        } else if (j > 0 && (move === 2 || i === 0)) {
          j -= 1;
        } else {
          break;
        }
      }

      // Propagate nearest known mapping to fill gaps
      let lastSeen = -1;
      for (let k = 0; k < wordToToken.length; k++) {
        if (wordToToken[k] !== -1) {
          lastSeen = wordToToken[k];
        } else if (lastSeen !== -1) {
          wordToToken[k] = lastSeen;
        }
      }
      let nextSeen = -1;
      for (let k = wordToToken.length - 1; k >= 0; k--) {
        if (wordToToken[k] !== -1) {
          nextSeen = wordToToken[k];
        } else if (nextSeen !== -1) {
          wordToToken[k] = nextSeen;
        }
      }
    }

    lastSentenceWordToTokenMap = wordToToken;
  }

  const mappedIndex =
    lastSentenceWordToTokenMap && wordIndex < lastSentenceWordToTokenMap.length
      ? lastSentenceWordToTokenMap[wordIndex]
      : -1;

  if (mappedIndex === -1) return;

  const chosenTokenIndex = mappedIndex;

  const token = lastTokens[chosenTokenIndex];
  const span = lastSpanNodes[token.spanIndex];
  if (!span) return;

  const node = token.textNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;

  try {
    const range = document.createRange();
    range.setStart(node, token.startOffset);
    range.setEnd(node, token.endOffset);

    const highlightTarget = getOrCreateHighlightLayer(span);
    if (!highlightTarget) return;

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
