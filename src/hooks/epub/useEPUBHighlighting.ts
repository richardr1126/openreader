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
  const wordRangeCacheRef = useRef<{
    key: string;
    spans: Array<AlignmentCharSpan | null>;
    ranges: Array<Range | null | undefined>;
    cfis: Array<string | null | undefined>;
  } | null>(null);
  const activeWordHighlightRef = useRef<{ key: string; wordIndex: number } | null>(null);
  const highlightedDocumentsRef = useRef<Set<Document>>(new Set());

  const clearPaintedHighlight = useCallback((name: string) => {
    for (const document of highlightedDocumentsRef.current) {
      clearRangeHighlight(document, name);
    }
  }, []);

  const clearWordHighlights = useCallback(() => {
    clearPaintedHighlight(EPUB_WORD_HIGHLIGHT);
    activeWordHighlightRef.current = null;
    if (!renditionRef.current) return;
    if (currentWordHighlightCfiRef.current) {
      renditionRef.current.annotations.remove(currentWordHighlightCfiRef.current, 'highlight');
      currentWordHighlightCfiRef.current = null;
    }
  }, [clearPaintedHighlight, currentWordHighlightCfiRef, renditionRef]);

  const clearHighlights = useCallback(() => {
    clearPaintedHighlight(EPUB_SEGMENT_HIGHLIGHT);
    if (renditionRef.current && currentHighlightCfiRef.current) {
      renditionRef.current.annotations.remove(currentHighlightCfiRef.current, 'highlight');
      currentHighlightCfiRef.current = null;
    }
    clearWordHighlights();
  }, [clearPaintedHighlight, clearWordHighlights, currentHighlightCfiRef, renditionRef]);

  const highlightSegment = useCallback((segment: CanonicalTtsSegment | null | undefined) => {
    if (!renditionRef.current) return;

    clearHighlights();

    if (!epubHighlightEnabled || !segment) return;

    const resolved = resolveVisibleSegmentRange(renderedTextMapsRef.current, segment);
    if (!resolved) return;

    if (paintRangeHighlight(
      resolved.range,
      EPUB_SEGMENT_HIGHLIGHT,
      'background-color: rgba(128, 128, 128, 0.32);',
    )) {
      const document = resolved.range.startContainer.ownerDocument;
      if (document) highlightedDocumentsRef.current.add(document);
      return;
    }

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
    if (!epubHighlightEnabled) {
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

    if (!renditionRef.current) {
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
        cfis: new Array(words.length).fill(undefined),
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

    if (paintRangeHighlight(
      wordRange,
      EPUB_WORD_HIGHLIGHT,
      `background-color: color-mix(in srgb, ${resolvePrimaryHighlightColor()} 40%, transparent);`,
    )) {
      const document = wordRange.startContainer.ownerDocument;
      if (document) highlightedDocumentsRef.current.add(document);
      if (currentWordHighlightCfiRef.current) {
        renditionRef.current.annotations.remove(currentWordHighlightCfiRef.current, 'highlight');
        currentWordHighlightCfiRef.current = null;
      }
      activeWordHighlightRef.current = { key: cacheKey, wordIndex };
      return;
    }

    let wordCfi = cache.cfis[wordIndex];
    if (wordCfi === undefined) {
      try {
        wordCfi = resolved.map.content.cfiFromRange(wordRange);
        cache.cfis[wordIndex] = wordCfi;
      } catch (error) {
        cache.cfis[wordIndex] = null;
        console.error('Error resolving EPUB word CFI:', error);
        clearWordHighlights();
        return;
      }
    }
    if (!wordCfi) {
      clearWordHighlights();
      return;
    }

    try {
      if (currentWordHighlightCfiRef.current && currentWordHighlightCfiRef.current !== wordCfi) {
        renditionRef.current.annotations.remove(currentWordHighlightCfiRef.current, 'highlight');
      }
      if (currentWordHighlightCfiRef.current === wordCfi) {
        activeWordHighlightRef.current = { key: cacheKey, wordIndex };
        return;
      }
      currentWordHighlightCfiRef.current = wordCfi;
      activeWordHighlightRef.current = { key: cacheKey, wordIndex };
      renditionRef.current.annotations.add(
        'highlight',
        wordCfi,
        {},
        () => { },
        '',
        {
          fill: resolvePrimaryHighlightColor(),
          'fill-opacity': '0.4',
          'mix-blend-mode': 'multiply',
        }
      );
    } catch (error) {
      console.error('Error highlighting EPUB word:', error);
      activeWordHighlightRef.current = null;
    }
  }, [
    clearWordHighlights,
    currentWordHighlightCfiRef,
    epubHighlightEnabled,
    renderedTextMapsRef,
    renditionRef,
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
