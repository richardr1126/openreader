'use client';

import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Rendition } from 'epubjs';

import {
  buildMonotonicWordToTokenMap,
  buildWordHighlightCacheKey,
  tokenizeCanonicalSegment,
  type EpubCanonicalWordToken,
} from '@/lib/client/epub/epub-word-highlight';
import {
  createRangeFromMappedOffsets,
  resolveVisibleSegmentRange,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment } from '@/types/tts';

export type EpubWordHighlightMapCache = {
  key: string;
  wordToToken: number[];
  tokens: EpubCanonicalWordToken[];
};

type UseEpubHighlightingParams = {
  renditionRef: RefObject<Rendition | undefined>;
  epubHighlightEnabled: boolean;
  currentHighlightCfiRef: MutableRefObject<string | null>;
  currentWordHighlightCfiRef: MutableRefObject<string | null>;
  renderedTextMapsRef: MutableRefObject<EpubRenderedTextMap[]>;
  wordHighlightMapCacheRef: MutableRefObject<EpubWordHighlightMapCache | null>;
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
  wordHighlightMapCacheRef,
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

    const cacheKey = buildWordHighlightCacheKey(segment, alignment);
    if (wordHighlightMapCacheRef.current?.key !== cacheKey) {
      const tokens = tokenizeCanonicalSegment(segment);
      wordHighlightMapCacheRef.current = {
        key: cacheKey,
        tokens,
        wordToToken: buildMonotonicWordToTokenMap(words, tokens),
      };
    }

    const cached = wordHighlightMapCacheRef.current;
    const tokenIndex = cached.wordToToken[wordIndex] ?? -1;
    if (tokenIndex < 0) return;

    const token = cached.tokens[tokenIndex];
    if (!token) return;
    if (token.sourceStart < resolved.startOffset || token.sourceEnd > resolved.endOffset) return;

    const wordRange = createRangeFromMappedOffsets(resolved.map, token.sourceStart, token.sourceEnd);
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
    wordHighlightMapCacheRef,
  ]);

  const setRenderedTextMaps = useCallback((maps: EpubRenderedTextMap[]) => {
    renderedTextMapsRef.current = maps;
    wordHighlightMapCacheRef.current = null;
  }, []);

  const resetHighlightState = useCallback(() => {
    renderedTextMapsRef.current = [];
    wordHighlightMapCacheRef.current = null;
    clearHighlights();
  }, [clearHighlights, renderedTextMapsRef, wordHighlightMapCacheRef]);

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
