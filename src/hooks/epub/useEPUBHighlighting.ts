'use client';

import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { Rendition } from 'epubjs';

import {
  createRangeFromMappedOffsets,
  resolveVisibleSegmentRange,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import {
  locateAlignmentWordSpans,
  type AlignmentCharSpan,
} from '@/lib/client/highlight-token-alignment';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment } from '@/types/tts';

type UseEpubHighlightingParams = {
  renditionRef: RefObject<Rendition | undefined>;
  epubHighlightEnabled: boolean;
  currentHighlightCfiRef: MutableRefObject<string | null>;
  currentWordHighlightCfiRef: MutableRefObject<string | null>;
  renderedTextMapsRef: MutableRefObject<EpubRenderedTextMap[]>;
};

type UseEpubHighlightingResult = {
  clearHighlights: () => void;
  highlightSegment: (segment: CanonicalTtsSegment | null | undefined) => void;
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
  renditionRef,
  epubHighlightEnabled,
  currentHighlightCfiRef,
  currentWordHighlightCfiRef,
  renderedTextMapsRef,
}: UseEpubHighlightingParams): UseEpubHighlightingResult {
  // Cache the per-segment word→region map so we don't re-align on every whisper
  // tick. Keyed by the segment + resolved region + the aligned word texts, so a
  // corrected/rebuilt alignment (even with an identical word count) misses the
  // cache instead of reusing stale spans.
  const wordRangeCacheRef = useRef<{ key: string; spans: Array<AlignmentCharSpan | null> } | null>(null);

  const clearWordHighlights = useCallback(() => {
    if (!renditionRef.current) return;
    if (currentWordHighlightCfiRef.current) {
      renditionRef.current.annotations.remove(currentWordHighlightCfiRef.current, 'highlight');
      currentWordHighlightCfiRef.current = null;
    }
  }, [currentWordHighlightCfiRef, renditionRef]);

  const clearHighlights = useCallback(() => {
    if (renditionRef.current && currentHighlightCfiRef.current) {
      renditionRef.current.annotations.remove(currentHighlightCfiRef.current, 'highlight');
      currentHighlightCfiRef.current = null;
    }
    clearWordHighlights();
  }, [clearWordHighlights, currentHighlightCfiRef, renditionRef]);

  const highlightSegment = useCallback((segment: CanonicalTtsSegment | null | undefined) => {
    if (!renditionRef.current) return;

    clearHighlights();

    if (!epubHighlightEnabled || !segment) return;

    const resolved = resolveVisibleSegmentRange(renderedTextMapsRef.current, segment);
    if (!resolved) return;

    try {
      const cfi = resolved.map.content.cfiFromRange(resolved.range);
      currentHighlightCfiRef.current = cfi;
      renditionRef.current.annotations.add(
        'highlight',
        cfi,
        {},
        () => { },
        '',
        { fill: 'grey', 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' },
      );
    } catch (error) {
      console.error('Error highlighting EPUB segment:', error);
    }
  }, [clearHighlights, currentHighlightCfiRef, epubHighlightEnabled, renderedTextMapsRef, renditionRef]);

  const highlightWordIndex = useCallback((
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    segment: CanonicalTtsSegment | null | undefined
  ) => {
    clearWordHighlights();

    if (!epubHighlightEnabled) return;
    if (!alignment) return;
    if (wordIndex === null || wordIndex === undefined || wordIndex < 0) return;

    const words = alignment.words || [];
    if (!words.length || wordIndex >= words.length) return;

    if (!renditionRef.current) return;

    if (!segment || segment.startAnchor.sourceKey !== segment.ownerSourceKey) return;

    const resolved = resolveVisibleSegmentRange(renderedTextMapsRef.current, segment);
    if (!resolved || segment.startAnchor.sourceKey !== resolved.map.sourceKey) return;

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
      };
    }

    const span = wordRangeCacheRef.current.spans[wordIndex];
    if (!span) return;

    const absStart = resolved.startOffset + span.start;
    const absEnd = resolved.startOffset + span.end;
    const wordRange = createRangeFromMappedOffsets(resolved.map, absStart, absEnd);
    if (!wordRange) return;

    try {
      const wordCfi = resolved.map.content.cfiFromRange(wordRange);
      currentWordHighlightCfiRef.current = wordCfi;
      renditionRef.current.annotations.add(
        'highlight',
        wordCfi,
        {},
        () => { },
        '',
        {
          fill: 'var(--accent)',
          'fill-opacity': '0.4',
          'mix-blend-mode': 'multiply',
        }
      );
    } catch (error) {
      console.error('Error highlighting EPUB word:', error);
    }
  }, [
    clearWordHighlights,
    currentWordHighlightCfiRef,
    epubHighlightEnabled,
    renderedTextMapsRef,
    renditionRef,
  ]);

  const setRenderedTextMaps = useCallback((maps: EpubRenderedTextMap[]) => {
    renderedTextMapsRef.current = maps;
    // Remapped content can change a region's text under an unchanged cache key,
    // so drop the word-span cache whenever the text maps are replaced.
    wordRangeCacheRef.current = null;
  }, [renderedTextMapsRef]);

  const resetHighlightState = useCallback(() => {
    renderedTextMapsRef.current = [];
    wordRangeCacheRef.current = null;
    clearHighlights();
  }, [clearHighlights, renderedTextMapsRef]);

  // Clear any highlight annotations when feature is disabled.
  useEffect(() => {
    if (!epubHighlightEnabled) {
      clearHighlights();
    }
  }, [epubHighlightEnabled, clearHighlights]);

  return {
    clearHighlights,
    highlightSegment,
    clearWordHighlights,
    highlightWordIndex,
    setRenderedTextMaps,
    resetHighlightState,
  };
}
