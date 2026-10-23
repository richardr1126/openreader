'use client';

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import {
  createRangeFromMappedOffsets,
  resolveVisibleSegmentRange,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import {
  locateAlignmentWordSpans,
  type AlignmentCharSpan,
} from '@/lib/client/highlight-token-alignment';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TTSSentenceAlignment } from '@/types/tts';
import {
  clearRangeHighlight,
  paintRangeHighlight,
} from '@/lib/client/highlight-range-painter';

const EPUB_SEGMENT_HIGHLIGHT = 'openreader-epub-segment';
const EPUB_WORD_HIGHLIGHT = 'openreader-epub-word';

const resolvePrimaryHighlightColor = (): string => {
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent')
    .trim();
  return accent || '#ef4444';
};

type UseEpubHighlightingParams = {
  epubHighlightEnabled: boolean;
  epubWordHighlightEnabled: boolean;
  renderedTextMapsRef: MutableRefObject<EpubRenderedTextMap[]>;
};

type UseEpubHighlightingResult = {
  clearHighlights: () => void;
  highlightSegment: (segment: CanonicalTtsSegment | null | undefined) => boolean;
  clearWordHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    segment: CanonicalTtsSegment | null | undefined
  ) => void;
  setRenderedTextMaps: (maps: EpubRenderedTextMap[]) => void;
  resetHighlightState: () => void;
};

export function useEPUBHighlighting({
  epubHighlightEnabled,
  epubWordHighlightEnabled,
  renderedTextMapsRef,
}: UseEpubHighlightingParams): UseEpubHighlightingResult {
  // Cache the per-segment word→region map so we don't re-align on every whisper
  // tick. Keyed by the segment + resolved region + the aligned word texts, so a
  // corrected/rebuilt alignment (even with an identical word count) misses the
  // cache instead of reusing stale spans.
  const wordRangeCacheRef = useRef<{
    key: string;
    spans: Array<AlignmentCharSpan | null>;
    ranges: Array<Range | null | undefined>;
  } | null>(null);
  const activeWordHighlightRef = useRef<{ key: string; wordIndex: number } | null>(null);
  const highlightedDocumentsRef = useRef<Set<Document>>(new Set());

  const clearPaintedHighlight = useCallback((name: string, except?: Document | null) => {
    for (const document of highlightedDocumentsRef.current) {
      if (document !== except) clearRangeHighlight(document, name);
    }
  }, []);

  const paintHighlight = useCallback((
    range: Range,
    name: string,
    declarations: string,
    priority: number,
  ): boolean => {
    if (!paintRangeHighlight(range, name, declarations, priority)) return false;
    // A section change can move the layer into another iframe document.
    const document = range.startContainer.ownerDocument;
    clearPaintedHighlight(name, document);
    if (document) highlightedDocumentsRef.current.add(document);
    return true;
  }, [clearPaintedHighlight]);

  const clearWordHighlights = useCallback(() => {
    clearPaintedHighlight(EPUB_WORD_HIGHLIGHT);
    activeWordHighlightRef.current = null;
  }, [clearPaintedHighlight]);

  const clearHighlights = useCallback(() => {
    clearPaintedHighlight(EPUB_SEGMENT_HIGHLIGHT);
    clearWordHighlights();
  }, [clearPaintedHighlight, clearWordHighlights]);

  // Repaints the segment layer in place and leaves the word layer to the word
  // effect, which commits in the same frame. Clearing both first made Safari
  // paint an intermediate frame on every sentence change.
  const highlightSegment = useCallback((segment: CanonicalTtsSegment | null | undefined) => {
    if (!epubHighlightEnabled) {
      clearPaintedHighlight(EPUB_SEGMENT_HIGHLIGHT);
      return !epubWordHighlightEnabled || Boolean(segment &&
        resolveVisibleSegmentRange(renderedTextMapsRef.current, segment));
    }
    const resolved = segment
      ? resolveVisibleSegmentRange(renderedTextMapsRef.current, segment)
      : null;
    if (!resolved || !paintHighlight(
      resolved.range,
      EPUB_SEGMENT_HIGHLIGHT,
      'background-color: rgba(128, 128, 128, 0.32);',
      0,
    )) {
      clearPaintedHighlight(EPUB_SEGMENT_HIGHLIGHT);
      return false;
    }
    return true;
  }, [clearPaintedHighlight, epubHighlightEnabled, epubWordHighlightEnabled, paintHighlight, renderedTextMapsRef]);

  const highlightWordIndex = useCallback((
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    segment: CanonicalTtsSegment | null | undefined
  ) => {
    if (!epubWordHighlightEnabled) {
      clearWordHighlights();
      return;
    }
    if (!alignment) {
      clearWordHighlights();
      return;
    }
    if (wordIndex === null || wordIndex === undefined || wordIndex < 0) {
      clearWordHighlights();
      return;
    }

    const words = alignment.words || [];
    if (!words.length || wordIndex >= words.length) {
      clearWordHighlights();
      return;
    }

    if (!segment) {
      clearWordHighlights();
      return;
    }

    const resolved = resolveVisibleSegmentRange(renderedTextMapsRef.current, segment);
    if (!resolved) {
      clearWordHighlights();
      return;
    }

    // Map each spoken word onto the rendered region with the shared token-
    // sequence aligner (same primitive as the HTML and PDF viewers). The region
    // text is the *rendered* text, so a returned span's offsets are already
    // indices into the char map — no canonical-vs-rendered coordinate drift.
    // Spans are relative to resolved.startOffset.
    const regionText = resolved.map.text.slice(resolved.startOffset, resolved.endOffset);
    const cacheKey = [
      segment.key,
      resolved.map.sourceKey,
      resolved.startOffset,
      resolved.endOffset,
      words.length,
      // Word texts (not timings) drive the span mapping, so include them: a
      // re-aligned segment with the same count still invalidates the cache.
      words.map((word) => word.text).join(''),
    ].join('::');
    if (wordRangeCacheRef.current?.key !== cacheKey) {
      wordRangeCacheRef.current = {
        key: cacheKey,
        spans: locateAlignmentWordSpans(words, regionText),
        ranges: new Array(words.length).fill(undefined),
      };
    }
    const cache = wordRangeCacheRef.current;

    const span = cache.spans[wordIndex];
    if (!span) {
      clearWordHighlights();
      return;
    }

    let wordRange = cache.ranges[wordIndex];
    if (wordRange === undefined) {
      const absStart = resolved.startOffset + span.start;
      const absEnd = resolved.startOffset + span.end;
      wordRange = createRangeFromMappedOffsets(resolved.map, absStart, absEnd);
      cache.ranges[wordIndex] = wordRange;
      if (!wordRange) {
        clearWordHighlights();
        return;
      }
    }
    if (!wordRange) {
      clearWordHighlights();
      return;
    }

    const active = activeWordHighlightRef.current;
    if (active && active.key === cacheKey && active.wordIndex === wordIndex) return;

    if (paintHighlight(
      wordRange,
      EPUB_WORD_HIGHLIGHT,
      `background-color: color-mix(in srgb, ${resolvePrimaryHighlightColor()} 40%, transparent);`,
      1,
    )) {
      activeWordHighlightRef.current = { key: cacheKey, wordIndex };
      return;
    }
    clearWordHighlights();
  }, [
    clearWordHighlights,
    epubWordHighlightEnabled,
    paintHighlight,
    renderedTextMapsRef,
  ]);

  const setRenderedTextMaps = useCallback((maps: EpubRenderedTextMap[]) => {
    clearPaintedHighlight(EPUB_SEGMENT_HIGHLIGHT);
    clearPaintedHighlight(EPUB_WORD_HIGHLIGHT);
    highlightedDocumentsRef.current.clear();
    renderedTextMapsRef.current = maps;
    // Remapped content can change a region's text under an unchanged cache key,
    // so drop the word-span cache whenever the text maps are replaced.
    wordRangeCacheRef.current = null;
    activeWordHighlightRef.current = null;
  }, [clearPaintedHighlight, renderedTextMapsRef]);

  const resetHighlightState = useCallback(() => {
    renderedTextMapsRef.current = [];
    wordRangeCacheRef.current = null;
    activeWordHighlightRef.current = null;
    clearHighlights();
    highlightedDocumentsRef.current.clear();
  }, [clearHighlights, renderedTextMapsRef]);

  // Each preference owns only its painted layer.
  useEffect(() => {
    if (!epubHighlightEnabled) {
      clearPaintedHighlight(EPUB_SEGMENT_HIGHLIGHT);
    }
  }, [epubHighlightEnabled, clearPaintedHighlight]);

  useEffect(() => {
    if (!epubWordHighlightEnabled) clearWordHighlights();
  }, [epubWordHighlightEnabled, clearWordHighlights]);

  return {
    clearHighlights,
    highlightSegment,
    clearWordHighlights,
    highlightWordIndex,
    setRenderedTextMaps,
    resetHighlightState,
  };
}
