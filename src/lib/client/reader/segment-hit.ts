/**
 * Tap-to-seek hit testing shared by the PDF, EPUB and HTML readers.
 *
 * A reader resolves a pointer position to the rendered unit that owns it (a
 * parsed PDF block, an HTML block, an EPUB rendered text map) and the plan
 * segments that unit was read into. This module turns that into exactly one
 * worker-plan ordinal, plus the token range of that sentence so the reader can
 * show a hover affordance over what a click would seek to.
 *
 * Words are tokenized with the same segmenter and normalizer the highlighters
 * use, so a sentence resolved here is the sentence the highlight would paint.
 */
import { segmentWords } from '@openreader/tts/language';
import { normalizeHighlightToken } from '@/lib/client/highlight-token-alignment';
import type { TTSSegmentLocator } from '@/types/client';

/** NodeFilter.SHOW_TEXT, spelled out so iframe documents need no global NodeFilter. */
const SHOW_TEXT = 0x4;

export type HitToken = {
  node: Text;
  start: number;
  end: number;
  text: string;
};

export type SeekCandidate = {
  ordinal: number;
  text: string;
};

type LocatedSegment = {
  ordinal: number;
  text: string;
  ownerLocator: TTSSegmentLocator | null;
};

/**
 * The rendered unit a plan segment is read from: a parsed PDF block
 * (`pdf:<page>:<blockId>`, the worker's source key) or an HTML block anchor.
 * The client plan carries only each segment's owner locator, so this is the
 * one place a segment is tied to the element a reader renders it in. Readers
 * without a block-shaped locator (EPUB) key every segment on its own.
 */
export function segmentSourceKey(segment: Pick<LocatedSegment, 'ordinal' | 'ownerLocator'>): string {
  const locator = segment.ownerLocator;
  if (locator?.readerType === 'pdf' && typeof locator.page === 'number' && locator.blockId) {
    return `pdf:${locator.page}:${locator.blockId}`;
  }
  if (locator?.readerType === 'html' && locator.location) return locator.location;
  return `segment:${segment.ordinal}`;
}

/** Group plan segments by the rendered unit that owns them, in plan order. */
export function indexSegmentsBySource(segments: readonly LocatedSegment[]): Map<string, SeekCandidate[]> {
  const index = new Map<string, SeekCandidate[]>();
  for (const segment of segments) {
    const key = segmentSourceKey(segment);
    const candidate = { ordinal: segment.ordinal, text: segment.text };
    const list = index.get(key);
    if (list) list.push(candidate);
    else index.set(key, [candidate]);
  }
  return index;
}

export type SegmentHit = {
  ordinal: number;
  /** Inclusive token window of the resolved sentence within the unit's tokens. */
  startToken: number;
  endToken: number;
};

export type CaretPosition = {
  node: Node;
  offset: number;
};

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The text position under a viewport point, in the given document's coordinates. */
export function caretAtPoint(doc: Document, x: number, y: number): CaretPosition | null {
  const caretDoc = doc as CaretDocument;
  if (typeof caretDoc.caretPositionFromPoint === 'function') {
    const position = caretDoc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof caretDoc.caretRangeFromPoint === 'function') {
    const range = caretDoc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** Word tokens of every visible text node under the given roots, in document order. */
export function collectTextTokens(roots: readonly Node[], language?: string): HitToken[] {
  const tokens: HitToken[] = [];
  for (const root of roots) {
    const doc = root.ownerDocument ?? (root as Document);
    const walker = doc.createTreeWalker(root, SHOW_TEXT);
    let current = walker.nextNode() as Text | null;
    while (current) {
      const value = current.nodeValue ?? '';
      if (value.trim()) {
        for (const word of segmentWords(value, language)) {
          if (!normalizeHighlightToken(word.text)) continue;
          tokens.push({ node: current, start: word.start, end: word.end, text: word.text });
        }
      }
      current = walker.nextNode() as Text | null;
    }
  }
  return tokens;
}

/**
 * The token a caret falls in. A caret between words resolves to the following
 * word in the same text node, then the preceding one; a caret outside every
 * token's text node is not a hit on text.
 */
export function tokenIndexAtCaret(tokens: readonly HitToken[], caret: CaretPosition | null): number {
  if (!caret) return -1;
  let previous = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.node !== caret.node) {
      if (previous >= 0) return previous;
      continue;
    }
    if (caret.offset < token.end) return index;
    previous = index;
  }
  return previous;
}

function tokenize(text: string, language?: string): string[] {
  return segmentWords(text, language)
    .map((word) => normalizeHighlightToken(word.text))
    .filter(Boolean);
}

function matchesAt(unitTokens: readonly string[], at: number, pattern: readonly string[]): boolean {
  if (at < 0 || at + pattern.length > unitTokens.length) return false;
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (unitTokens[at + offset] !== pattern[offset]) return false;
  }
  return true;
}

/**
 * Exact in-order placement of every candidate's tokens, or null when the text
 * diverged (including a sentence that continues into the next unit).
 */
function exactWindows(candidateTokens: string[][], unitTokens: string[]): Array<[number, number]> | null {
  const windows: Array<[number, number]> = [];
  const count = unitTokens.length;
  let cursor = 0;
  for (const pattern of candidateTokens) {
    if (pattern.length === 0) return null;
    let found = -1;
    for (let start = cursor; start + pattern.length <= count; start += 1) {
      if (matchesAt(unitTokens, start, pattern)) {
        found = start;
        break;
      }
    }
    if (found < 0) return null;
    windows.push([found, found + pattern.length - 1]);
    cursor = found + pattern.length;
  }
  return windows;
}

/**
 * Proportional placement when rendered words and planned words diverge
 * (hyphenation, ligatures, dropped glyphs): candidates split the unit in the
 * ratio of their word counts, which keeps them consecutive and covering.
 */
function proportionalWindows(candidateTokens: string[][], unitTokenCount: number): Array<[number, number]> {
  const counts = candidateTokens.map((tokens) => Math.max(1, tokens.length));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const windows: Array<[number, number]> = [];
  let consumed = 0;
  for (const count of counts) {
    const start = Math.round((consumed / total) * unitTokenCount);
    consumed += count;
    const end = Math.max(start, Math.round((consumed / total) * unitTokenCount) - 1);
    windows.push([start, Math.min(end, unitTokenCount - 1)]);
  }
  return windows;
}

/** Each candidate's inclusive token window within one unit's rendered tokens. */
function candidateWindows(
  candidates: readonly SeekCandidate[],
  unitTokenTexts: readonly string[],
  language?: string,
): Array<[number, number]> {
  if (candidates.length === 1) return [[0, unitTokenTexts.length - 1]];
  const unitTokens = unitTokenTexts.map(normalizeHighlightToken);
  const candidateTokens = candidates.map((candidate) => tokenize(candidate.text, language));
  return exactWindows(candidateTokens, unitTokens) ?? proportionalWindows(candidateTokens, unitTokens.length);
}

/**
 * Resolve the plan segment a token belongs to among the consecutive segments
 * read from one rendered unit.
 */
export function pickSegmentForToken(
  candidates: readonly SeekCandidate[],
  unitTokenTexts: readonly string[],
  tokenIndex: number,
  language?: string,
): SegmentHit | null {
  if (candidates.length === 0 || tokenIndex < 0 || tokenIndex >= unitTokenTexts.length) return null;
  const windows = candidateWindows(candidates, unitTokenTexts, language);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  windows.forEach(([start, end], index) => {
    const distance = tokenIndex < start ? start - tokenIndex : tokenIndex > end ? tokenIndex - end : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  const [startToken, endToken] = windows[best];
  return { ordinal: candidates[best].ordinal, startToken, endToken };
}

/** A DOM range spanning an inclusive token window. */
export function rangeForTokens(tokens: readonly HitToken[], startToken: number, endToken: number): Range | null {
  const first = tokens[startToken];
  const last = tokens[endToken];
  if (!first || !last) return null;
  try {
    const range = first.node.ownerDocument.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);
    return range;
  } catch {
    return null;
  }
}

const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"]';
/** Pointer travel beyond this is a drag (or a text selection gesture), not a tap. */
const TAP_SLOP_PX = 6;

type TapEvent = Pick<MouseEvent, 'button' | 'clientX' | 'clientY' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>;

/**
 * Distinguishes a tap on reading text from link clicks, drags, and the click
 * that ends a text selection. Readers record the pointer-down position and ask
 * on click.
 */
export function createTapGuard() {
  let down: { x: number; y: number } | null = null;
  return {
    pointerDown(event: { clientX: number; clientY: number; button: number }) {
      down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    },
    isTap(event: TapEvent): boolean {
      const start = down;
      down = null;
      if (event.button !== 0 || event.defaultPrevented) return false;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return false;
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest(INTERACTIVE_SELECTOR)) return false;
      const view = (target?.ownerDocument?.defaultView ?? null) as Window | null;
      const selection = view?.getSelection?.();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return false;
      return true;
    },
  };
}

/** Name of the hover affordance painted over the sentence a tap would seek to. */
export const SEEK_HOVER_HIGHLIGHT = 'openreader-seek-hover';
export const SEEK_HOVER_DECLARATIONS = 'text-decoration: underline dotted color-mix(in srgb, var(--accent, #ef4444) 70%, transparent); text-decoration-thickness: 2px; text-underline-offset: 3px; background-color: color-mix(in srgb, var(--accent, #ef4444) 14%, transparent);';

function pointIsOnToken(token: HitToken, x: number, y: number): boolean {
  try {
    const range = token.node.ownerDocument.createRange();
    range.setStart(token.node, token.start);
    range.setEnd(token.node, token.end);
    const slop = 2;
    return Array.from(range.getClientRects()).some((rect) => (
      x >= rect.left - slop && x <= rect.right + slop && y >= rect.top - slop && y <= rect.bottom + slop
    ));
  } catch {
    return false;
  }
}

/**
 * Resolve a point inside one rendered unit to the sentence under it. The
 * point must be on a word: blank margins and line ends, where a caret would
 * snap to the nearest text, do not seek.
 */
export function resolvePointInUnit(
  roots: readonly Node[],
  candidates: readonly SeekCandidate[],
  point: { clientX: number; clientY: number },
  language?: string,
): { ordinal: number; range: Range | null } | null {
  if (candidates.length === 0 || roots.length === 0) return null;
  const doc = roots[0].ownerDocument;
  if (!doc) return null;
  const tokens = collectTextTokens(roots, language);
  const tokenIndex = tokenIndexAtCaret(tokens, caretAtPoint(doc, point.clientX, point.clientY));
  if (tokenIndex < 0 || !pointIsOnToken(tokens[tokenIndex], point.clientX, point.clientY)) return null;
  const hit = pickSegmentForToken(candidates, tokens.map((token) => token.text), tokenIndex, language);
  if (!hit) return null;
  return { ordinal: hit.ordinal, range: rangeForTokens(tokens, hit.startToken, hit.endToken) };
}

/**
 * The rendered extent of the unit's sentences whose ordinals fall in
 * `[from, to]`, or null when none of them is in this unit.
 */
export function rangeForOrdinalsInUnit(
  roots: readonly Node[],
  candidates: readonly SeekCandidate[],
  from: number,
  to: number,
  language?: string,
): Range | null {
  const first = candidates.findIndex((candidate) => candidate.ordinal >= from && candidate.ordinal <= to);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < candidates.length && candidates[last + 1].ordinal <= to) last += 1;
  const tokens = collectTextTokens(roots, language);
  if (tokens.length === 0) return null;
  const windows = candidateWindows(candidates, tokens.map((token) => token.text), language);
  const range = rangeForTokens(tokens, windows[first][0], windows[last][1]);
  // Take in the closing punctuation the last word token leaves out, stopping
  // at the next word for scripts that don't space their sentences.
  const end = tokens[windows[last][1]];
  if (range && end) {
    const text = end.node.nodeValue ?? '';
    let offset = end.end;
    while (offset < text.length && !/[\s\p{L}\p{N}]/u.test(text[offset])) offset += 1;
    range.setEnd(end.node, offset);
  }
  return range;
}

/**
 * The sentence a selection boundary falls in. At a caret between words the
 * `start` edge takes the following word and the `end` edge the preceding one,
 * so the snapped selection never takes in a sentence nothing was selected in;
 * null when no word of the unit lies on the selected side.
 */
export function ordinalAtCaretInUnit(
  roots: readonly Node[],
  candidates: readonly SeekCandidate[],
  caret: CaretPosition,
  edge: 'start' | 'end',
  language?: string,
): number | null {
  if (candidates.length === 0 || roots.length === 0) return null;
  const tokens = collectTextTokens(roots, language);
  if (tokens.length === 0) return null;
  const doc = roots[0].ownerDocument ?? (roots[0] as Document);
  const at = doc.createRange();
  try {
    at.setStart(caret.node, caret.offset);
  } catch {
    return null;
  }
  const tokenIndex = edge === 'start'
    ? tokens.findIndex((token) => at.comparePoint(token.node, token.end) > 0)
    : tokens.findLastIndex((token) => at.comparePoint(token.node, token.start) < 0);
  // A start after the unit's last word, or an end before its first, selects nothing here.
  if (tokenIndex < 0) return null;
  return pickSegmentForToken(candidates, tokens.map((token) => token.text), tokenIndex, language)?.ordinal ?? null;
}

/**
 * The first and last sentence a selection covers among the rendered units it
 * crosses, each unit with its own plan sentences. A boundary outside every
 * unit (in a margin) snaps to the nearest unit edge the selection reaches.
 */
export function resolveSelectionInUnits<Unit>(
  range: Range,
  units: readonly Unit[],
  unitRoots: (unit: Unit) => readonly Node[],
  candidatesFor: (unit: Unit) => readonly SeekCandidate[],
  language?: string,
): { start: number; end: number } | null {
  const touched = units.filter((unit) => {
    const candidates = candidatesFor(unit);
    return candidates.length > 0 && unitRoots(unit).some((root) => range.intersectsNode(root));
  });
  if (touched.length === 0) return null;
  const boundary = (unit: Unit, edge: 'start' | 'end') => {
    const roots = unitRoots(unit);
    const node = edge === 'start' ? range.startContainer : range.endContainer;
    const inside = roots.some((root) => root === node || root.contains(node));
    const caret: CaretPosition = inside
      ? { node, offset: edge === 'start' ? range.startOffset : range.endOffset }
      : edge === 'start'
        ? { node: roots[0], offset: 0 }
        : { node: roots[roots.length - 1], offset: roots[roots.length - 1].childNodes.length };
    return ordinalAtCaretInUnit(roots, candidatesFor(unit), caret, edge, language);
  };
  // A selection ending at the very start of a unit touches it without
  // selecting any of its words, so look inward from each end.
  let start: number | null = null;
  for (let index = 0; start === null && index < touched.length; index += 1) start = boundary(touched[index], 'start');
  let end: number | null = null;
  for (let index = touched.length - 1; end === null && index >= 0; index -= 1) end = boundary(touched[index], 'end');
  // Snapping inward can cross over: a selection of only the punctuation
  // between two sentences takes in neither.
  if (start === null || end === null || start > end) return null;
  return { start, end };
}
