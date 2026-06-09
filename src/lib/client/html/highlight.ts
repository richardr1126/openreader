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
 * Word-to-DOM alignment is native: the Whisper alignment gives authoritative
 * `charStart`/`charEnd` offsets into the sentence text, and we map those offsets
 * directly onto a normalized char→DOM map of the located sentence wrap. No fuzzy
 * token matching for words — that path used to jump the highlight to a later
 * word in the sentence.
 */
import type { TTSSentenceAlignment } from '@/types/tts';
import { segmentWords } from '@/lib/shared/language';
import {
  findBestHighlightTokenMatch,
  normalizeHighlightToken,
} from '@/lib/client/highlight-token-alignment';
import { normalizeMappedChars, type MappedChar } from '@/lib/client/highlight-char-map';

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
  // Normalized text of the wrap (chars joined), used to locate the sentence so
  // alignment char offsets can be rebased onto the wrap.
  text: string;
  // For an alignment we've already seen: the offset of `sentence` inside `text`
  // (the wrap window may be slightly wider than the sentence). null = not found.
  alignment: TTSSentenceAlignment | null;
  base: number | null;
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
 * Text node + offset it came from, so alignment char offsets map straight to a
 * DOM range. Normalization matches `preprocessSentenceForAudio` (the canonical
 * space the alignment offsets live in).
 */
function collectWrapCharMap(wraps: HTMLSpanElement[]): { chars: CharPosition[]; text: string } {
  const raw: MappedChar<CharPosition>[] = [];
  for (const wrap of wraps) {
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    let current: Node | null = walker.nextNode();
    while (current) {
      const t = current as Text;
      const value = t.nodeValue || '';
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
    alignment: null,
    base: null,
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

  // Locate the sentence inside the wrap's normalized text once per alignment.
  // The sentence wrap is found by fuzzy token windowing so it may be slightly
  // wider than the spoken sentence; rebasing keeps the alignment char offsets
  // accurate regardless.
  if (sentenceState.alignment !== alignment || sentenceState.base === null) {
    const found = sentenceState.text.indexOf(alignment.sentence);
    if (found < 0) {
      // Sentence not located in the wrap — fail closed (leave only the sentence
      // highlight) rather than snapping the word highlight to offset 0. Don't
      // commit the alignment so the next tick retries the lookup.
      sentenceState.base = null;
      return false;
    }
    sentenceState.alignment = alignment;
    sentenceState.base = found;
  }

  const base = sentenceState.base;
  if (base === null) return false;

  const word = words[wordIndex];
  const { charStart, charEnd } = word;
  if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) || charEnd <= charStart) return false;

  const start = Math.max(0, base + charStart);
  const end = Math.min(sentenceState.chars.length, base + charEnd);
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
