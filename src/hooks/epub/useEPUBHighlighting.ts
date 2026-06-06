'use client';

import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Rendition } from 'epubjs';

import {
  buildWordHighlightCacheKey,
  resolveAlignmentWordSourceRange,
  tokenizeCanonicalSegment,
  type EpubCanonicalWordToken,
} from '@/lib/client/epub/epub-word-highlight';
import {
  buildAlignmentTokenRanges,
  type HighlightTokenRange,
} from '@/lib/client/highlight-token-alignment';
import {
  createRangeFromMappedOffsets,
  resolveVisibleSegmentRange,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';
import type { TTSSentenceAlignment } from '@/types/tts';

export type EpubWordHighlightMapCache = {
  key: string;
  wordToTokenRange: Array<HighlightTokenRange | null>;
  tokens: EpubCanonicalWordToken[];
};

type UseEpubHighlightingParams = {
  renditionRef: RefObject<Rendition | undefined>;
  epubHighlightEnabled: boolean;
  currentHighlightCfiRef: MutableRefObject<string | null>;
  currentWordHighlightCfiRef: MutableRefObject<string | null>;
  renderedTextMapsRef: MutableRefObject<EpubRenderedTextMap[]>;
  wordHighlightMapCacheRef: MutableRefObject<EpubWordHighlightMapCache | null>;
  language?: string;
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
  language,
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

    const alignmentRange = resolveAlignmentWordSourceRange(segment, words[wordIndex]);
    if (
      alignmentRange
      && alignmentRange.sourceStart >= resolved.startOffset
      && alignmentRange.sourceEnd <= resolved.endOffset
    ) {
      const wordRange = createRangeFromMappedOffsets(
        resolved.map,
        alignmentRange.sourceStart,
        alignmentRange.sourceEnd,
      );
      if (wordRange) {
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
          return;
        } catch (error) {
          console.error('Error highlighting EPUB word from alignment offsets:', error);
        }
      }
    }

    const cacheKey = buildWordHighlightCacheKey(segment, alignment, language);
    if (wordHighlightMapCacheRef.current?.key !== cacheKey) {
      const tokens = tokenizeCanonicalSegment(segment, language);
      wordHighlightMapCacheRef.current = {
        key: cacheKey,
        tokens,
        wordToTokenRange: buildAlignmentTokenRanges(
          words,
          tokens.map((token) => token.norm),
          { minimumSimilarity: 0.8 },
        ),
      };
    }

    const cached = wordHighlightMapCacheRef.current;
    const tokenRange = cached.wordToTokenRange[wordIndex];
    if (!tokenRange) return;

    const firstToken = cached.tokens[tokenRange.start];
    const lastToken = cached.tokens[tokenRange.end];
    if (!firstToken || !lastToken) return;
    if (firstToken.sourceStart < resolved.startOffset || lastToken.sourceEnd > resolved.endOffset) return;

    const wordRange = createRangeFromMappedOffsets(
      resolved.map,
      firstToken.sourceStart,
      lastToken.sourceEnd,
    );
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
    language,
  ]);

  const setRenderedTextMaps = useCallback((maps: EpubRenderedTextMap[]) => {
    renderedTextMapsRef.current = maps;
    wordHighlightMapCacheRef.current = null;
  }, [renderedTextMapsRef, wordHighlightMapCacheRef]);

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
