'use client';

import {
  useState,
  useCallback,
  useMemo,
  useRef,
  RefObject,
  useEffect,
} from 'react';

import type { NavItem } from 'epubjs';
import type { Book, Rendition } from 'epubjs';

import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { buildEpubCanonicalWindow } from '@/lib/client/epub/epub-canonical-window';
import { useTTS } from '@/contexts/TTSContext';
import { createRangeCfi } from '@/lib/client/epub';
import { normalizeTtsLocationKey } from '@openreader/tts/locator';
import { useConfig } from '@/contexts/ConfigContext';
import {
  buildRenderedTextMaps,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import {
  useEPUBHighlighting,
} from '@/hooks/epub/useEPUBHighlighting';
import { useEPUBLocationController } from '@/hooks/epub/useEPUBLocationController';
import { useEPUBAudiobook } from '@/hooks/epub/useEPUBAudiobook';
import type {
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type { AudiobookGenerationSettings, TTSSegmentLocator } from '@/types/client';
import { buildSegmentKeyPrefix, type CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import { normalizeOptionalLanguageTag } from '@openreader/tts/language';
import type { BaseDocument } from '@/types/documents';
import type { ScheduleDocumentProgress } from '@/types/user-state';

export interface EpubDocumentState {
  currDocData: ArrayBuffer | undefined;
  currDocName: string | undefined;
  currDocPages: number | undefined;
  currDocPage: number | string;
  currDocText: string | undefined;
  metadataLanguage: string | null;
  isPlaybackReady: boolean;
  setCurrentDocument: (metadata: BaseDocument, initialLocation?: string) => Promise<void>;
  clearCurrDoc: () => void;
  extractPageText: (book: Book, rendition: Rendition, shouldPause?: boolean) => Promise<string>;
  createFullAudioBook: (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    bookId?: string,
    format?: TTSAudiobookFormat,
    settings?: AudiobookGenerationSettings
  ) => Promise<string>;
  regenerateChapter: (
    chapterIndex: number,
    bookId: string,
    format: TTSAudiobookFormat,
    signal: AbortSignal,
    settings?: AudiobookGenerationSettings
  ) => Promise<TTSAudiobookChapter>;
  bookRef: RefObject<Book | null>;
  renditionRef: RefObject<Rendition | undefined>;
  tocRef: RefObject<NavItem[]>;
  locationRef: RefObject<string | number>;
  handleLocationChanged: (location: string | number) => void;
  setRendition: (rendition: Rendition) => void;
  isAudioCombining: boolean;
  highlightSegment: (segment: CanonicalTtsSegment | null | undefined) => void;
  clearHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    segment: CanonicalTtsSegment | null | undefined
  ) => void;
  clearWordHighlights: () => void;
}

/**
 * Route-local EPUB reader hook.
 */
export function useEpubDocument(
  documentId: string | undefined,
  scheduleProgress: ScheduleDocumentProgress,
): EpubDocumentState {
  const {
    setText: setTTSText,
    currDocPage,
    currDocPages,
    setCurrDocPages,
    stop,
    skipToLocation,
    setIsEPUB,
    resolvedLanguage,
  } = useTTS();
  // Configuration context to get TTS settings
  const {
    providerRef,
    ttsSegmentMaxBlockLength,
    epubTheme,
    epubHighlightEnabled,
  } = useConfig();
  // Current document state
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  const [metadataLanguage, setMetadataLanguage] = useState<string | null>(null);
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);
  const [isAudioCombining] = useState(false);

  // Add new refs
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | undefined>(undefined);
  const tocRef = useRef<NavItem[]>([]);
  const locationRef = useRef<string | number>(currDocPage);
  const isEPUBSetOnce = useRef(false);
  const renditionEventsCleanupRef = useRef<(() => void) | null>(null);
  // Should pause ref
  const shouldPauseRef = useRef(true);
  // Track current highlight CFI for removal
  const currentHighlightCfi = useRef<string | null>(null);
  const currentWordHighlightCfi = useRef<string | null>(null);
  const renderedTextMapsRef = useRef<EpubRenderedTextMap[]>([]);
  const {
    clearHighlights,
    highlightSegment,
    clearWordHighlights,
    highlightWordIndex,
    setRenderedTextMaps,
    resetHighlightState,
  } = useEPUBHighlighting({
    renditionRef,
    epubHighlightEnabled,
    currentHighlightCfiRef: currentHighlightCfi,
    currentWordHighlightCfiRef: currentWordHighlightCfi,
    renderedTextMapsRef,
  });

  /**
   * Clears all current document state and stops any active TTS
   */
  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setCurrDocText(undefined);
    setMetadataLanguage(null);
    setIsPlaybackReady(false);
    setCurrDocPages(undefined);
    isEPUBSetOnce.current = false;
    shouldPauseRef.current = true;
    bookRef.current = null;
    renditionEventsCleanupRef.current?.();
    renditionEventsCleanupRef.current = null;
    renditionRef.current = undefined;
    locationRef.current = 1;
    tocRef.current = [];
    resetHighlightState();
    stop();
  }, [resetHighlightState, setCurrDocPages, stop]);

  /**
   * Sets the current document based on its ID using server metadata and the browser blob cache.
   * @param {string} id - The unique identifier of the document
   * @throws {Error} When document data is empty or retrieval fails
   */
  const setCurrentDocument = useCallback(async (meta: BaseDocument, initialLocation?: string): Promise<void> => {
    try {
      setIsPlaybackReady(false);
      setMetadataLanguage(null);
      bookRef.current = null;
      renditionEventsCleanupRef.current?.();
      renditionEventsCleanupRef.current = null;
      renditionRef.current = undefined;
      locationRef.current = initialLocation || 1;
      const doc = await ensureCachedDocument(meta);
      if (doc.type !== 'epub') {
        clearCurrDoc();
        console.error('Document is not an EPUB');
        return;
      }

      if (doc.data.byteLength === 0) {
        console.error('Retrieved ArrayBuffer is empty');
        throw new Error('Empty document data');
      }

      setCurrDocName(doc.name);
      setCurrDocData(doc.data); // Store ArrayBuffer directly
    } catch (error) {
      console.error('Failed to get EPUB document:', error);
      clearCurrDoc(); // Clean up on error
      throw error;
    }
  }, [clearCurrDoc]);

  /**
   * Extracts text content from the current EPUB page/location
   * @param {Book} book - The EPUB.js Book instance
   * @param {Rendition} rendition - The EPUB.js Rendition instance
   * @param {boolean} shouldPause - Whether to pause TTS
   * @returns {Promise<string>} The extracted text content
   */
  const extractPageText = useCallback(async (book: Book, rendition: Rendition, shouldPause = false): Promise<string> => {
    try {
      setIsPlaybackReady(false);
      const location = rendition?.location;
      if (!location) return '';
      const { start, end } = location;
      if (!start?.cfi || !end?.cfi || !book || !book.isOpen || !rendition) return '';

      // Guard against stale async completion: this function awaits range +
      // canonical-plan resolution, during which rapid page turns can move the
      // rendition on. If the live location no longer matches the page we
      // captured, bail before writing state so we don't overwrite the active
      // page's segments/highlights with a superseded page's.
      const capturedStartCfi = start.cfi;
      const isStale = (): boolean => {
        const live = rendition.location?.start?.cfi;
        return Boolean(live) && live !== capturedStartCfi;
      };

      const rangeCfi = createRangeCfi(start.cfi, end.cfi);

      const range = await book.getRange(rangeCfi);
      if (!range) {
        console.warn('Failed to get range from CFI:', rangeCfi);
        return '';
      }
      if (isStale()) return '';
      const textContent = range.toString().trim();
      setRenderedTextMaps(buildRenderedTextMaps(
        rendition,
        rangeCfi,
        normalizeTtsLocationKey(start.cfi),
      ));

      // Canonical path: derive this page's TTS segments as a window into the
      // chapter's single, viewport-independent canonical plan. This is what
      // keeps a block that straddles a page break identical (same key/ordinal)
      // on both pages, so playback never repeats or wrongly pauses at the seam.
      const keyPrefix = buildSegmentKeyPrefix(documentId, 'epub');
      const canonicalWindow = await buildEpubCanonicalWindow(book, {
        startCfi: start.cfi,
        viewportText: textContent,
        keyPrefix,
        maxBlockLength: ttsSegmentMaxBlockLength,
        language: resolvedLanguage,
        // Match the rendered text map's sourceKey so the page's canonical
        // segments resolve to highlight ranges.
        viewportAnchorSourceKey: normalizeTtsLocationKey(start.cfi),
      });

      // The plan resolution above can load + segment a whole chapter; re-check
      // that we're still on the captured page before committing TTS state.
      if (isStale()) return '';

      if (canonicalWindow) {
        setTTSText(textContent, {
          shouldPause,
          location: start.cfi,
          canonicalSegments: canonicalWindow.segments,
          canonicalSpine: {
            spineHref: canonicalWindow.spineHref,
            spineIndex: canonicalWindow.spineIndex,
          },
        });
      } else {
        // Fallback for spine boundaries, footnotes/nav/image pages, or text not
        // indexable in the spine. The worker stream derives continuation from
        // the persisted document; this local path only seeds the visible window.
        setTTSText(textContent, {
          shouldPause,
          location: start.cfi,
        });
      }

      setCurrDocText(textContent);
      setIsPlaybackReady(true);

      return textContent;
    } catch (error) {
      console.error('Error extracting EPUB text:', error);
      return '';
    }
  }, [setRenderedTextMaps, setTTSText, documentId, ttsSegmentMaxBlockLength, resolvedLanguage]);

  const { createFullAudioBook, regenerateChapter } = useEPUBAudiobook({
    bookRef,
    tocRef,
    providerRef,
  });

  const setRendition = useCallback((rendition: Rendition) => {
    renditionEventsCleanupRef.current?.();
    const book = rendition.book;
    bookRef.current = book;
    renditionRef.current = rendition;
    const initializeFromRelocated = () => {
      if (renditionRef.current !== rendition || isEPUBSetOnce.current || !book.isOpen) return;
      const location = rendition.location?.start?.cfi;
      if (!location) return;

      setIsEPUB(true);
      isEPUBSetOnce.current = true;
      locationRef.current = location;
      skipToLocation(location);
      void extractPageText(book, rendition, shouldPauseRef.current);
      shouldPauseRef.current = true;
    };
    rendition.on('relocated', initializeFromRelocated);
    renditionEventsCleanupRef.current = () => {
      rendition.off('relocated', initializeFromRelocated);
    };
    void book.loaded.metadata
      .then((metadata) => {
        if (bookRef.current !== book) return;
        setMetadataLanguage(normalizeOptionalLanguageTag(metadata.language));
      })
      .catch((error) => {
        if (bookRef.current !== book) return;
        setMetadataLanguage(null);
        console.warn('Failed to read EPUB language metadata:', error);
      });
  }, [extractPageText, setIsEPUB, skipToLocation]);

  const handleLocationChanged = useEPUBLocationController({
    documentId,
    isEpubSetOnceRef: isEPUBSetOnce,
    shouldPauseRef,
    setIsEpub: setIsEPUB,
    skipToLocation,
    extractPageText,
    bookRef,
    renditionRef,
    locationRef,
    scheduleProgress,
  });



  return useMemo(
    () => ({
      setCurrentDocument,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      metadataLanguage,
      isPlaybackReady,
      clearCurrDoc,
      extractPageText,
      createFullAudioBook,
      regenerateChapter,
      bookRef,
      renditionRef,
      tocRef,
      locationRef,
      handleLocationChanged,
      setRendition,
      isAudioCombining,
      highlightSegment,
      clearHighlights,
      highlightWordIndex,
      clearWordHighlights,
    }),
    [
      setCurrentDocument,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      metadataLanguage,
      isPlaybackReady,
      clearCurrDoc,
      extractPageText,
      createFullAudioBook,
      regenerateChapter,
      handleLocationChanged,
      setRendition,
      isAudioCombining,
      highlightSegment,
      clearHighlights,
      highlightWordIndex,
      clearWordHighlights,
    ]
  );
}
