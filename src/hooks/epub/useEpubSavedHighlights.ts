'use client';

import { useEffect, useMemo, type RefObject } from 'react';
import { useTTS } from '@/contexts/TTSContext';
import { useLatestRef } from '@/hooks/useLatestRef';
import { paintRangeHighlights } from '@/lib/client/highlight-range-painter';
import {
  createRangeFromMappedOffsets,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import { indexEpubSegmentSpans, type EpubSpineSpan } from '@/lib/client/epub/epub-segment-hit';
import { SAVED_HIGHLIGHT } from '@/lib/client/reader/saved-highlights';
import { bindSelectionReporting, useReaderHighlights } from '@/components/reader/ReaderHighlights';

/** The first map character at or after (`'start'`) or before (`'end'`) a DOM point. */
function mapIndexAt(map: EpubRenderedTextMap, node: Node, offset: number, edge: 'start' | 'end'): number {
  const at = map.content.document.createRange();
  try {
    at.setStart(node, offset);
  } catch {
    return -1;
  }
  // Characters are in document order, so search for the first one at or after the point.
  let low = 0;
  let high = map.chars.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const position = map.chars[mid];
    if (at.comparePoint(position.node, position.offset) < 0) low = mid + 1;
    else high = mid;
  }
  return edge === 'start' ? (low < map.chars.length ? low : -1) : low - 1;
}

/** The sentences a selection in one section covers, by spine character offset. */
function selectionOrdinals(
  map: EpubRenderedTextMap,
  spans: readonly EpubSpineSpan[],
  range: Range,
): { start: number; end: number } | null {
  const first = mapIndexAt(map, range.startContainer, range.startOffset, 'start');
  const last = mapIndexAt(map, range.endContainer, range.endOffset, 'end');
  if (first < 0 || last < first) return null;
  const covered = spans.filter((span) => span.end > first && span.start <= last);
  if (covered.length === 0) return null;
  return { start: covered[0].ordinal, end: covered[covered.length - 1].ordinal };
}

/**
 * Paint saved highlights in each rendered EPUB section and report text
 * selections there, through the same committed text maps the narration
 * highlight paints from.
 */
export function useEpubSavedHighlights({
  renderedTextMapsRef,
  renderedTextRevision,
}: {
  renderedTextMapsRef: RefObject<EpubRenderedTextMap[]>;
  renderedTextRevision: number;
}) {
  const { playbackSegments } = useTTS();
  const { highlights, declarations, reportSelection } = useReaderHighlights();
  const spansBySpine = useMemo(() => indexEpubSegmentSpans(playbackSegments), [playbackSegments]);
  const spansRef = useLatestRef(spansBySpine);

  useEffect(() => {
    const rangesByDocument = new Map<Document, Range[]>();
    for (const map of renderedTextMapsRef.current ?? []) {
      const doc = map.content.document;
      const ranges = rangesByDocument.get(doc) ?? [];
      rangesByDocument.set(doc, ranges);
      const spans = spansBySpine.get(map.spineIndex) ?? [];
      for (const entry of highlights) {
        const covered = spans.filter((span) => span.ordinal >= entry.start && span.ordinal <= entry.end);
        if (covered.length === 0) continue;
        const start = Math.min(...covered.map((span) => span.start));
        const end = Math.min(map.chars.length, Math.max(...covered.map((span) => span.end)));
        const range = createRangeFromMappedOffsets(map, start, end);
        if (range) ranges.push(range);
      }
    }
    rangesByDocument.forEach((ranges, doc) => {
      paintRangeHighlights(doc, SAVED_HIGHLIGHT, ranges, declarations, -1);
    });
  }, [declarations, highlights, renderedTextMapsRef, renderedTextRevision, spansBySpine]);

  useEffect(() => {
    const maps = renderedTextMapsRef.current ?? [];
    const documents = new Set(maps.map((map) => map.content.document));
    const unbinders = Array.from(documents, (doc) => bindSelectionReporting(
      doc,
      (range) => {
        let start: number | null = null;
        let end: number | null = null;
        for (const map of renderedTextMapsRef.current ?? []) {
          if (map.content.document !== doc) continue;
          const hit = selectionOrdinals(map, spansRef.current.get(map.spineIndex) ?? [], range);
          if (!hit) continue;
          start = start === null ? hit.start : Math.min(start, hit.start);
          end = end === null ? hit.end : Math.max(end, hit.end);
        }
        return start === null || end === null ? null : { start, end };
      },
      reportSelection,
      () => {
        const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
        return { x: frame?.left ?? 0, y: frame?.top ?? 0 };
      },
    ));
    return () => unbinders.forEach((unbind) => unbind());
  }, [renderedTextMapsRef, renderedTextRevision, reportSelection, spansRef]);
}
