'use client';

import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Rendition } from 'epubjs';

import {
  resolveAlignmentWordSourceRange,
} from '@/lib/client/epub/epub-word-highlight';
import {
  createRangeFromMappedOffsets,
  resolveVisibleSegmentRange,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
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

    // Native path only: the alignment's char offsets are authoritative for the
    // spoken word (they live in the same canonical space as the segment text and
    // the rendered char map). Clamp to the portion of the segment that is
    // actually visible in this map so a word straddling a page/spread boundary
    // still highlights its visible part instead of dropping the word entirely.
    const alignmentRange = resolveAlignmentWordSourceRange(segment, words[wordIndex]);
    if (!alignmentRange) return;

    const clampedStart = Math.max(alignmentRange.sourceStart, resolved.startOffset);
    const clampedEnd = Math.min(alignmentRange.sourceEnd, resolved.endOffset);
    if (clampedEnd <= clampedStart) return;

    const wordRange = createRangeFromMappedOffsets(resolved.map, clampedStart, clampedEnd);
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
      console.error('Error highlighting EPUB word from alignment offsets:', error);
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
  }, [renderedTextMapsRef]);

  const resetHighlightState = useCallback(() => {
    renderedTextMapsRef.current = [];
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
