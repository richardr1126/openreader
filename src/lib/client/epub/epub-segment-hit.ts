'use client';

import {
  normalizeSegmentIdentityText,
  type CanonicalTtsSegment,
} from '@openreader/tts/segment-plan';
import { isStableEpubLocator } from '@/types/client';
import {
  createRangeFromMappedOffsets,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import { caretAtPoint } from '@/lib/client/reader/segment-hit';
import type { TapSeekTarget } from '@/lib/client/reader/tap-to-seek';

export type EpubSpineSpan = { ordinal: number; start: number; end: number };

/**
 * Spine-coordinate extents of every EPUB plan segment, keyed by spine index
 * and sorted by start. The extent rule matches `resolveVisibleSegmentRange`,
 * so a tap resolves to exactly the span the sentence highlight paints.
 */
export function indexEpubSegmentSpans(segments: readonly CanonicalTtsSegment[]): Map<number, EpubSpineSpan[]> {
  const index = new Map<number, EpubSpineSpan[]>();
  for (const segment of segments) {
    const locator = segment.ownerLocator;
    if (!isStableEpubLocator(locator)) continue;
    const start = Math.max(0, Math.floor(locator.charOffset));
    const end = start + Math.max(1, normalizeSegmentIdentityText(segment.text).length);
    const list = index.get(locator.spineIndex);
    const span = { ordinal: segment.ordinal, start, end };
    if (list) list.push(span);
    else index.set(locator.spineIndex, [span]);
  }
  for (const list of index.values()) list.sort((a, b) => a.start - b.start);
  return index;
}

/** The segment whose extent contains a spine offset, if any. */
export function epubSpanAtOffset(spans: readonly EpubSpineSpan[], offset: number): EpubSpineSpan | null {
  let low = 0;
  let high = spans.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (spans[mid].start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const span = found >= 0 ? spans[found] : null;
  return span && offset < span.end ? span : null;
}

function charContainsPoint(map: EpubRenderedTextMap, index: number, x: number, y: number): boolean {
  const range = createRangeFromMappedOffsets(map, index, index + 1);
  if (!range) return false;
  const slop = 2;
  return Array.from(range.getClientRects()).some((rect) => (
    x >= rect.left - slop && x <= rect.right + slop && y >= rect.top - slop && y <= rect.bottom + slop
  ));
}

/**
 * Resolve a point in a rendered EPUB section document to the plan segment
 * under it, through the committed rendered text maps (DOM position -> spine
 * character offset -> segment).
 */
export function resolveEpubPointHit(
  maps: readonly EpubRenderedTextMap[],
  spansBySpine: ReadonlyMap<number, EpubSpineSpan[]>,
  doc: Document,
  point: { clientX: number; clientY: number },
): TapSeekTarget | null {
  const caret = caretAtPoint(doc, point.clientX, point.clientY);
  if (!caret) return null;
  for (const map of maps) {
    if (typeof map.baseCharOffset !== 'number' || typeof map.spineIndex !== 'number') continue;
    if (map.chars[0]?.node.ownerDocument !== doc) continue;
    let index = -1;
    for (let i = 0; i < map.chars.length; i += 1) {
      const position = map.chars[i];
      if (position.node === caret.node && position.offset >= caret.offset) {
        index = i;
        break;
      }
      if (position.node === caret.node) index = i;
    }
    if (index < 0) continue;
    // A caret snaps to the nearest character; only a point on the glyph (or
    // the one before it) is a tap on text.
    if (!charContainsPoint(map, index, point.clientX, point.clientY)) {
      if (index === 0 || !charContainsPoint(map, index - 1, point.clientX, point.clientY)) return null;
      index -= 1;
    }
    const spans = spansBySpine.get(map.spineIndex) ?? [];
    const mapStart = Math.max(0, Math.floor(map.baseCharOffset));
    const span = epubSpanAtOffset(spans, mapStart + index);
    if (!span) return null;
    const range = createRangeFromMappedOffsets(
      map,
      Math.max(0, span.start - mapStart),
      Math.min(map.chars.length, span.end - mapStart),
    );
    return { ordinal: span.ordinal, range };
  }
  return null;
}
