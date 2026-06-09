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
 * Word-to-DOM alignment uses token-sequence alignment — the same primitive the
 * PDF viewer uses. The located sentence wrap is reduced to a normalized char→DOM
 * map; we tokenize that wrap text into words and globally align the Whisper
 * words against those tokens (`buildAlignmentTokenRanges`). Each word then maps
 * to a `[start, end)` char span in the wrap, which `wrapCharRange` turns into a
 * DOM span. This tolerates divergent transcription, punctuation, whitespace, and
 * markdown inline-element concatenation, and `fillGaps` guarantees every word
 * resolves to a neighboring token rather than vanishing.
 */
import type { TTSSentenceAlignment } from '@/types/tts';
import { segmentWords } from '@/lib/shared/language';
import {
  findBestHighlightTokenMatch,
  locateAlignmentWordSpans,
  normalizeHighlightToken,
  type AlignmentCharSpan,
} from '@/lib/client/highlight-token-alignment';
import {
  normalizeMappedChars,
  type MappedChar,
} from '@/lib/client/highlight-char-map';

export const HTML_SENTENCE_CLASS = 'openreader-html-highlight-sentence';
export const HTML_WORD_CLASS = 'openreader-html-highlight-word';

interface DomToken {
  textNode: Text;
  startOffset: number;
  endOffset: number;
  norm: string;
}

interface CharPosition {
  node: Text;
  offset: number;
}

let sentenceWraps: HTMLSpanElement[] = [];
let wordWraps: HTMLSpanElement[] = [];

/**
 * Per-sentence state used by the word highlighter. Built once when the
 * sentence wrap is applied and then read by every word-advance event, so we
 * don't re-walk the DOM on every whisper tick.
 */
interface SentenceState {
  sentence: string;
  // Normalized char→DOM map of the sentence wrap. `chars[i]` is the DOM position
  // of the i-th character of `text`. Built AFTER the sentence wrap is in place;
  // stable across word wrap/unwrap cycles because clear() calls
  // `parent.normalize()` which restores the original text-node structure.
  chars: CharPosition[];
  // Normalized text of the wrap (chars joined), tokenized to align each spoken
  // word against the rendered words.
  text: string;
  // Locale captured when the sentence was highlighted, reused for locale-aware
  // word segmentation when mapping the alignment (matters for CJK/Thai, etc.).
  language?: string;
  // For an alignment we've already seen: each word's [start, end) char span
  // within `text`/`chars` (null entries = words that aligned to no token).
  alignment: TTSSentenceAlignment | null;
  wordRanges: Array<AlignmentCharSpan | null> | null;
}

let sentenceState: SentenceState | null = null;

function normalizeWord(word: string): string {
  return normalizeHighlightToken(word);
}

function tokenizePattern(pattern: string, language?: string): string[] {
  return segmentWords(pattern, language).map((token) => normalizeWord(token.text)).filter(Boolean);
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

function collectDomTokens(
  root: HTMLElement,
  language?: string,
  opts: { skipHighlightWraps: boolean } = { skipHighlightWraps: true },
): DomToken[] {
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
    for (const token of segmentWords(text, language)) {
      const norm = normalizeWord(token.text);
      if (!norm) continue;
      tokens.push({
        textNode,
        startOffset: token.start,
        endOffset: token.end,
        norm,
      });
    }
    current = walker.nextNode();
  }
  return tokens;
}

/**
 * Walk inside the current sentence wrap spans and build a normalized char→DOM
 * map. Every surviving character of the normalized text remembers the exact
 * Text node + offset it came from, so an aligned word's char span maps straight
 * to a DOM range. Normalization matches `preprocessSentenceForAudio` (the
 * canonical space the alignment lives in).
 *
 * Crucially, a synthetic space is inserted between adjacent text nodes when the
 * boundary isn't already whitespace. ReactMarkdown renders inline formatting as
 * sibling nodes ("The <strong>quick</strong> brown" → "The"|"quick"|" brown")
 * and the inter-word space lives at a node edge that the wrap drops — without
 * this, the words would concatenate into "Thequick", collapsing distinct words
 * into one token and destroying per-word highlight granularity. The synthetic
 * space sits on a word boundary, so it is never inside an aligned word's span
 * and never becomes a highlight target.
 */
function collectWrapCharMap(wraps: HTMLSpanElement[]): { chars: CharPosition[]; text: string } {
  const raw: MappedChar<CharPosition>[] = [];
  for (const wrap of wraps) {
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    let current: Node | null = walker.nextNode();
    while (current) {
      const t = current as Text;
      const value = t.nodeValue || '';
      const lastChar = raw.length ? raw[raw.length - 1].char : '';
      if (lastChar && !/\s/.test(lastChar) && value.length && !/\s/.test(value[0])) {
        raw.push({ char: ' ', pos: { node: t, offset: 0 } });
      }
      for (let offset = 0; offset < value.length; offset += 1) {
        raw.push({ char: value[offset], pos: { node: t, offset } });
      }
      current = walker.nextNode();
    }
  }
  const normalized = normalizeMappedChars(raw);
  return {
    chars: normalized.map((entry) => entry.pos),
    text: normalized.map((entry) => entry.char).join(''),
  };
}

function findBestWindow(tokens: DomToken[], patternTokens: string[]): { start: number; end: number } | null {
  const match = findBestHighlightTokenMatch(patternTokens, tokens.map((token) => token.norm));
  if (match.start === -1 || match.rating < 0.5) return null;
  return { start: match.start, end: match.end };
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

/**
 * Wrap a half-open char range [start, end) of the sentence char map. Groups the
 * covered characters by Text node (min/max offset per node) and splits/wraps
 * each, mirroring `wrapTokenRange` but driven by per-character DOM positions.
 */
function wrapCharRange(chars: CharPosition[], start: number, end: number, className: string): HTMLSpanElement[] {
  const perNode = new Map<Text, { start: number; end: number }>();
  for (let i = start; i < end; i += 1) {
    const pos = chars[i];
    if (!pos) continue;
    const existing = perNode.get(pos.node);
    if (existing) {
      existing.start = Math.min(existing.start, pos.offset);
      existing.end = Math.max(existing.end, pos.offset + 1);
    } else {
      perNode.set(pos.node, { start: pos.offset, end: pos.offset + 1 });
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
  language?: string,
): boolean {
  clearHtmlSentenceHighlight();
  if (!container || !sentence?.trim()) return false;

  const patternTokens = tokenizePattern(sentence, language);
  if (!patternTokens.length) return false;

  const domTokens = collectDomTokens(container, language);
  if (!domTokens.length) return false;

  const win = findBestWindow(domTokens, patternTokens);
  if (!win) return false;

  sentenceWraps = wrapTokenRange(domTokens, win.start, win.end, HTML_SENTENCE_CLASS);
  if (!sentenceWraps.length) return false;

  // Capture the normalized char→DOM map AFTER the sentence wrap is in place so
  // we can resolve individual word offsets without re-walking the doc.
  const { chars, text } = collectWrapCharMap(sentenceWraps);
  sentenceState = {
    sentence,
    chars,
    text,
    language,
    alignment: null,
    wordRanges: null,
  };
  return true;
}

export function highlightHtmlWord(
  container: HTMLElement | null | undefined,
  alignment: TTSSentenceAlignment | undefined,
  wordIndex: number | null | undefined,
): boolean {
  // Always tear down the previous word wrap first. The `unwrap` call
  // normalizes the parent, restoring the post-sentence-wrap text-node
  // structure that `sentenceState.chars` points at, so the cached map
  // stays valid across consecutive word advances.
  clearHtmlWordHighlight();
  if (!container || !alignment) return false;
  if (wordIndex === null || wordIndex === undefined || wordIndex < 0) return false;
  if (!sentenceState || !sentenceState.chars.length) return false;
  if (!sentenceWraps.length) return false;

  const words = alignment.words || [];
  if (!words.length || wordIndex >= words.length) return false;

  // Map each spoken word to a char span of the wrap's normalized text with the
  // shared token-sequence aligner (same primitive as the EPUB and PDF viewers).
  // The sentence wrap is located by fuzzy token windowing, so absolute char
  // offsets can't be trusted; token alignment re-syncs every word against the
  // rendered words and won't jump to a later/duplicate word.
  if (sentenceState.alignment !== alignment || !sentenceState.wordRanges) {
    sentenceState.alignment = alignment;
    sentenceState.wordRanges = locateAlignmentWordSpans(words, sentenceState.text, sentenceState.language);
  }

  const range = sentenceState.wordRanges[wordIndex];
  if (!range) return false;

  const start = Math.max(0, range.start);
  const end = Math.min(sentenceState.chars.length, range.end);
  if (end <= start) return false;

  wordWraps = wrapCharRange(sentenceState.chars, start, end, HTML_WORD_CLASS);
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
