/**
 * HTML / TXT / MD reader highlight layer.
 *
 * Wraps text in `<span class="openreader-html-highlight-...">` so the visible
 * background change works in every browser (no CSS Custom Highlight API
 * dependency). The HTMLViewer renders the document once and never re-runs
 * ReactMarkdown until a new doc is loaded, so wrapping DOM nodes is safe.
 *
 * Two layers:
 *  - `SENTENCE` — softer translucent background covering the current TTS
 *    sentence
 *  - `WORD` — saturated background on the currently-spoken word
 *
 * Word-to-DOM alignment is done via Needleman-Wunsch (same approach the PDF
 * reader uses) so DOM token counts that diverge from whisper's word count
 * still produce a smooth, monotonic word highlight rather than a proportional
 * approximation that snaps around when the counts disagree.
 */
import { CmpStr } from 'cmpstr';
import type { TTSSentenceAlignment } from '@/types/tts';

export const HTML_SENTENCE_CLASS = 'openreader-html-highlight-sentence';
export const HTML_WORD_CLASS = 'openreader-html-highlight-word';

interface DomToken {
  textNode: Text;
  startOffset: number;
  endOffset: number;
  norm: string;
}

const cmp = CmpStr.create().setMetric('dice').setFlags('itw');

let sentenceWraps: HTMLSpanElement[] = [];
let wordWraps: HTMLSpanElement[] = [];

/**
 * Per-sentence state used by the word highlighter. Built once when the
 * sentence wrap is applied and then read by every word-advance event, so we
 * don't re-walk the DOM or re-run the DP on every whisper tick.
 */
interface SentenceState {
  sentence: string;
  // DOM tokens inside the wrapped sentence, captured AFTER the sentence wrap
  // is in place. Stable across word wrap/unwrap cycles because clear() calls
  // `parent.normalize()` which restores the original text-node structure.
  wordTokens: DomToken[];
  // For an alignment we've already seen, the cached wordIndex → tokenIndex map.
  alignment: TTSSentenceAlignment | null;
  wordToToken: number[] | null;
}

let sentenceState: SentenceState | null = null;

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, '')
    .trim();
}

function tokenizePattern(pattern: string): string[] {
  const out: string[] = [];
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(pattern)) !== null) {
    const norm = normalizeWord(m[0]);
    if (norm) out.push(norm);
  }
  return out;
}

function unwrap(span: HTMLSpanElement): void {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) {
    parent.insertBefore(span.firstChild, span);
  }
  parent.removeChild(span);
  if (typeof (parent as Element).normalize === 'function') {
    (parent as Element).normalize();
  }
}

export function clearHtmlSentenceHighlight(): void {
  // Word wraps live inside sentence wraps. Tear them down first so we don't
  // orphan them in the DOM when the sentence wrap is unwrapped — otherwise
  // collectDomTokens would later refuse to walk those text nodes (they'd
  // still be inside a highlight-class span) and the NEXT sentence highlight
  // would silently miss matching tokens.
  clearHtmlWordHighlight();
  for (const span of sentenceWraps) unwrap(span);
  sentenceWraps = [];
  // A sentence clear also invalidates the word-mapping cache; the new
  // sentence will get its own state when highlightHtmlSentence runs again.
  sentenceState = null;
}

export function clearHtmlWordHighlight(): void {
  for (const span of wordWraps) unwrap(span);
  wordWraps = [];
}

function isHighlightWrapper(node: Node | null): node is HTMLSpanElement {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (el.tagName !== 'SPAN') return false;
  return el.classList.contains(HTML_SENTENCE_CLASS) || el.classList.contains(HTML_WORD_CLASS);
}

function collectDomTokens(root: HTMLElement, opts: { skipHighlightWraps: boolean } = { skipHighlightWraps: true }): DomToken[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (opts.skipHighlightWraps) {
        let ancestor: Node | null = parent;
        while (ancestor && ancestor !== root) {
          if (isHighlightWrapper(ancestor)) return NodeFilter.FILTER_REJECT;
          ancestor = ancestor.parentNode;
        }
      }
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const tokens: DomToken[] = [];
  let current: Node | null = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const text = textNode.nodeValue || '';
    const wordRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text)) !== null) {
      const norm = normalizeWord(m[0]);
      if (!norm) continue;
      tokens.push({
        textNode,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        norm,
      });
    }
    current = walker.nextNode();
  }
  return tokens;
}

/**
 * Walk only inside the current sentence wrap spans (used after the sentence
 * wrap is applied; lets us index just the words *within* the highlighted
 * sentence rather than the whole document).
 */
function collectTokensInsideWraps(wraps: HTMLSpanElement[]): DomToken[] {
  const tokens: DomToken[] = [];
  for (const wrap of wraps) {
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    let current: Node | null = walker.nextNode();
    while (current) {
      const t = current as Text;
      const text = t.nodeValue || '';
      const wordRe = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = wordRe.exec(text)) !== null) {
        const norm = normalizeWord(m[0]);
        if (!norm) continue;
        tokens.push({
          textNode: t,
          startOffset: m.index,
          endOffset: m.index + m[0].length,
          norm,
        });
      }
      current = walker.nextNode();
    }
  }
  return tokens;
}

function findBestWindow(tokens: DomToken[], patternTokens: string[]): { start: number; end: number } | null {
  if (!tokens.length || !patternTokens.length) return null;
  const pLen = patternTokens.length;

  let bestStart = -1;
  let bestEnd = -1;
  let bestScore = 0;

  for (let i = 0; i + Math.max(1, Math.ceil(pLen * 0.5)) - 1 < tokens.length; i += 1) {
    if (tokens[i].norm !== patternTokens[0]) continue;
    let matches = 1;
    let domCursor = i + 1;
    for (let p = 1; p < pLen && domCursor < tokens.length; p += 1) {
      let stepped = false;
      for (let k = 0; k < 3 && domCursor + k < tokens.length; k += 1) {
        if (tokens[domCursor + k].norm === patternTokens[p]) {
          matches += 1;
          domCursor += k + 1;
          stepped = true;
          break;
        }
      }
      if (!stepped) domCursor += 1;
    }
    const end = Math.min(tokens.length - 1, domCursor - 1);
    const score = matches / pLen;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestEnd = end;
      if (score >= 0.95) break;
    }
  }

  if (bestScore >= 0.5 && bestStart !== -1) {
    return { start: bestStart, end: bestEnd };
  }
  return null;
}

function wrapTokenRange(tokens: DomToken[], start: number, end: number, className: string): HTMLSpanElement[] {
  const perNode = new Map<Text, { start: number; end: number }>();
  for (let i = start; i <= end; i += 1) {
    const t = tokens[i];
    const existing = perNode.get(t.textNode);
    if (existing) {
      existing.start = Math.min(existing.start, t.startOffset);
      existing.end = Math.max(existing.end, t.endOffset);
    } else {
      perNode.set(t.textNode, { start: t.startOffset, end: t.endOffset });
    }
  }

  const wraps: HTMLSpanElement[] = [];
  for (const [textNode, { start: s, end: e }] of perNode) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    try {
      let target: Text = textNode;
      if (s > 0) {
        target = target.splitText(s);
      }
      const innerLen = e - s;
      if (innerLen < target.length) {
        target.splitText(innerLen);
      }
      const span = document.createElement('span');
      span.className = className;
      parent.insertBefore(span, target);
      span.appendChild(target);
      wraps.push(span);
    } catch {
      // skip any text node that can't be split (already wrapped, detached, etc.)
    }
  }
  return wraps;
}

export function highlightHtmlSentence(
  container: HTMLElement | null | undefined,
  sentence: string | null | undefined,
): boolean {
  clearHtmlSentenceHighlight();
  if (!container || !sentence?.trim()) return false;

  const patternTokens = tokenizePattern(sentence);
  if (!patternTokens.length) return false;

  const domTokens = collectDomTokens(container);
  if (!domTokens.length) return false;

  const win = findBestWindow(domTokens, patternTokens);
  if (!win) return false;

  sentenceWraps = wrapTokenRange(domTokens, win.start, win.end, HTML_SENTENCE_CLASS);
  if (!sentenceWraps.length) return false;

  // Capture the per-token DOM map AFTER the sentence wrap is in place so we
  // can look up individual word tokens without re-walking the doc.
  sentenceState = {
    sentence,
    wordTokens: collectTokensInsideWraps(sentenceWraps),
    alignment: null,
    wordToToken: null,
  };
  return true;
}

/**
 * Build a wordIndex → tokenIndex map via Needleman-Wunsch alignment between
 * whisper's word list and the DOM tokens inside the sentence. Mirrors the
 * approach in `src/lib/client/pdf.ts#highlightWordIndex` so PDF and HTML
 * highlights behave the same way under count mismatches (contractions,
 * stripped punctuation, missing whitespace, etc.).
 */
function buildAlignmentMap(
  alignment: TTSSentenceAlignment,
  domTokens: DomToken[],
): number[] {
  const words = alignment.words || [];
  const wordToToken = new Array<number>(words.length).fill(-1);

  const domFiltered: { tokenIndex: number; norm: string }[] = [];
  for (let i = 0; i < domTokens.length; i += 1) {
    const norm = domTokens[i].norm;
    if (norm) domFiltered.push({ tokenIndex: i, norm });
  }

  const ttsFiltered: { wordIndex: number; norm: string }[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const norm = normalizeWord(words[i].text);
    if (norm) ttsFiltered.push({ wordIndex: i, norm });
  }

  const m = domFiltered.length;
  const n = ttsFiltered.length;
  if (!m || !n) return wordToToken;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY),
  );
  const bt: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  ); // 0=diag (substitute), 1=up (skip dom), 2=left (skip tts)

  dp[0][0] = 0;
  const GAP_COST = 0.7;

  for (let i = 0; i <= m; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      if (i > 0 && j > 0) {
        const a = domFiltered[i - 1].norm;
        const b = ttsFiltered[j - 1].norm;
        const sim = a === b ? 1 : cmp.compare(a, b);
        const cand = dp[i - 1][j - 1] + (1 - sim);
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
      const domIdx = domFiltered[i - 1].tokenIndex;
      const ttsIdx = ttsFiltered[j - 1].wordIndex;
      if (wordToToken[ttsIdx] === -1) wordToToken[ttsIdx] = domIdx;
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

  // Forward-fill, then backward-fill, so every wordIndex has a nearest known
  // DOM token. This keeps the word highlight stable when whisper emits a
  // word that didn't survive normalization (e.g. an apostrophe-only token).
  let lastSeen = -1;
  for (let k = 0; k < wordToToken.length; k += 1) {
    if (wordToToken[k] !== -1) lastSeen = wordToToken[k];
    else if (lastSeen !== -1) wordToToken[k] = lastSeen;
  }
  let nextSeen = -1;
  for (let k = wordToToken.length - 1; k >= 0; k -= 1) {
    if (wordToToken[k] !== -1) nextSeen = wordToToken[k];
    else if (nextSeen !== -1) wordToToken[k] = nextSeen;
  }

  return wordToToken;
}

export function highlightHtmlWord(
  container: HTMLElement | null | undefined,
  alignment: TTSSentenceAlignment | undefined,
  wordIndex: number | null | undefined,
): boolean {
  // Always tear down the previous word wrap first. The `unwrap` call
  // normalizes the parent, restoring the post-sentence-wrap text-node
  // structure that `sentenceState.wordTokens` points at, so the cached map
  // stays valid across consecutive word advances.
  clearHtmlWordHighlight();
  if (!container || !alignment) return false;
  if (wordIndex === null || wordIndex === undefined || wordIndex < 0) return false;
  if (!sentenceState || !sentenceState.wordTokens.length) return false;
  if (!sentenceWraps.length) return false;

  const words = alignment.words || [];
  if (!words.length || wordIndex >= words.length) return false;

  // (Re)build the alignment map when this is a new alignment object.
  if (sentenceState.alignment !== alignment || !sentenceState.wordToToken) {
    sentenceState.alignment = alignment;
    sentenceState.wordToToken = buildAlignmentMap(alignment, sentenceState.wordTokens);
  }

  const tokenIndex = sentenceState.wordToToken[wordIndex];
  if (tokenIndex === undefined || tokenIndex < 0) return false;
  if (tokenIndex >= sentenceState.wordTokens.length) return false;

  wordWraps = wrapTokenRange(sentenceState.wordTokens, tokenIndex, tokenIndex, HTML_WORD_CLASS);
  return wordWraps.length > 0;
}

/**
 * Scroll the first sentence wrapper into view if it's not already visible.
 * Cheap idempotent — call after highlightHtmlSentence.
 */
export function scrollSentenceIntoView(container: HTMLElement | null | undefined): void {
  if (!container || !sentenceWraps.length) return;
  const first = sentenceWraps[0];
  const containerRect = container.getBoundingClientRect();
  const rect = first.getBoundingClientRect();
  const above = rect.top < containerRect.top + 40;
  const below = rect.bottom > containerRect.bottom - 40;
  if (above || below) {
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
