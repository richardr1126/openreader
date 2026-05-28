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

import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { EpubRenderedLocationCloneManager } from '@/lib/client/epub/rendered-location-walker';
import { canonicalizeEpubSegmentAgainstSpineText } from '@/lib/client/epub/canonicalize-epub-segment';
import { buildEpubLocator, getSpineItemPlainText } from '@/lib/client/epub/spine-coordinates';
import { useTTS, type EpubLocatorResolver } from '@/contexts/TTSContext';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { createRangeCfi } from '@/lib/client/epub';
import { normalizeTtsLocationKey } from '@/lib/shared/tts-locator';
import { useConfig } from '@/contexts/ConfigContext';
import {
  collectContinuationFromRange,
  collectLeadingContextFromRange,
} from '@/lib/client/epub/epub-range-context';
import {
  buildRenderedTextMaps,
  type EpubRenderedTextMap,
} from '@/lib/client/epub/epub-rendered-text-maps';
import {
  useEPUBHighlighting,
  type EpubWordHighlightMapCache,
} from '@/hooks/epub/useEPUBHighlighting';
import { useEPUBLocationController } from '@/hooks/epub/useEPUBLocationController';
import { useEPUBAudiobook } from '@/hooks/epub/useEPUBAudiobook';
import type {
  EpubRenderedLocationWalker,
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type { AudiobookGenerationSettings, TTSSegmentLocator } from '@/types/client';
import { isStableEpubLocator } from '@/types/client';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';

export interface EpubDocumentState {
  currDocData: ArrayBuffer | undefined;
  currDocName: string | undefined;
  currDocPages: number | undefined;
  currDocPage: number | string;
  currDocText: string | undefined;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;
  extractPageText: (book: Book, rendition: Rendition, shouldPause?: boolean) => Promise<string>;
  walkUpcomingRenderedLocations: EpubRenderedLocationWalker;
  resolveEpubLocator: EpubLocatorResolver;
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
export function useEpubDocument(documentId?: string): EpubDocumentState {
  const { setText: setTTSText, currDocPage, currDocPages, setCurrDocPages, stop, skipToLocation, setIsEPUB } = useTTS();
  const { authEnabled } = useAuthConfig();
  // Configuration context to get TTS settings
  const {
    apiKey,
    baseUrl,
    providerRef,
    ttsSegmentMaxBlockLength,
    epubTheme,
    epubHighlightEnabled,
  } = useConfig();
  // Current document state
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  // Mirror state into a ref so resolveEpubLocator (registered once with
  // TTSContext via a stable callback) can always read the latest page text
  // without forcing re-registration on every page turn.
  const currDocTextRef = useRef<string | undefined>(undefined);
  useEffect(() => { currDocTextRef.current = currDocText; }, [currDocText]);
  const [isAudioCombining] = useState(false);

  // Add new refs
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | undefined>(undefined);
  const tocRef = useRef<NavItem[]>([]);
  const locationRef = useRef<string | number>(currDocPage);
  const isEPUBSetOnce = useRef(false);
  // Should pause ref
  const shouldPauseRef = useRef(true);
  // Track current highlight CFI for removal
  const currentHighlightCfi = useRef<string | null>(null);
  const currentWordHighlightCfi = useRef<string | null>(null);
  const renderedTextMapsRef = useRef<EpubRenderedTextMap[]>([]);
  const wordHighlightMapCacheRef = useRef<EpubWordHighlightMapCache | null>(null);
  const renderedLocationCloneManagerRef = useRef<EpubRenderedLocationCloneManager>(
    new EpubRenderedLocationCloneManager(),
  );
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
    wordHighlightMapCacheRef,
  });

  useEffect(() => () => {
    void renderedLocationCloneManagerRef.current.destroy();
  }, []);

  useEffect(() => {
    renderedLocationCloneManagerRef.current.invalidate();
  }, [currDocData]);

  /**
   * Clears all current document state and stops any active TTS
   */
  const clearCurrDoc = useCallback(() => {
    setCurrDocData(undefined);
    setCurrDocName(undefined);
    setCurrDocText(undefined);
    setCurrDocPages(undefined);
    isEPUBSetOnce.current = false;
    shouldPauseRef.current = true;
    bookRef.current = null;
    renditionRef.current = undefined;
    locationRef.current = 1;
    tocRef.current = [];
    resetHighlightState();
    renderedLocationCloneManagerRef.current.invalidate();
    stop();
  }, [resetHighlightState, setCurrDocPages, stop]);

  /**
   * Sets the current document based on its ID by fetching from IndexedDB
   * @param {string} id - The unique identifier of the document
   * @throws {Error} When document data is empty or retrieval fails
   */
  const setCurrentDocument = useCallback(async (id: string): Promise<void> => {
    try {
      const meta = await getDocumentMetadata(id);
      if (!meta) {
        clearCurrDoc();
        console.error('Document not found on server');
        return;
      }

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
      const location = rendition?.location;
      if (!location) return '';
      const { start, end } = location;
      if (!start?.cfi || !end?.cfi || !book || !book.isOpen || !rendition) return '';

      const rangeCfi = createRangeCfi(start.cfi, end.cfi);

      const range = await book.getRange(rangeCfi);
      if (!range) {
        console.warn('Failed to get range from CFI:', rangeCfi);
        return '';
      }
      const textContent = range.toString().trim();
      setRenderedTextMaps(buildRenderedTextMaps(
        rendition,
        rangeCfi,
        normalizeTtsLocationKey(start.cfi),
      ));
      const leadingPreview = collectLeadingContextFromRange(range);
      const continuationPreview = collectContinuationFromRange(range);

      setTTSText(textContent, {
        shouldPause,
        location: start.cfi,
        previousText: leadingPreview,
        nextLocation: end.cfi,
        nextText: continuationPreview
      });
      setCurrDocText(textContent);

      return textContent;
    } catch (error) {
      console.error('Error extracting EPUB text:', error);
      return '';
    }
  }, [setRenderedTextMaps, setTTSText]);

  /**
   * Resolves a draft EPUB locator (typically `{ readerType: 'epub', location:
   * <CFI> }`) into stable spine coordinates using the live `Book` instance.
   * Registered with TTSContext so segment-persist payloads are normalised to
   * viewport-independent coordinates before they hit the server.
   *
   * Returns null when there's no live book or the CFI doesn't resolve.
   */
  const resolveEpubLocator = useCallback<EpubLocatorResolver>(async (
    draft,
    segmentText,
    options,
  ) => {
    const book = bookRef.current;
    if (!book || !book.isOpen) return null;
    const resolvedLocator = (() => {
      if (isStableEpubLocator(draft)) return Promise.resolve(draft);
      const cfi = (typeof draft.cfi === 'string' && draft.cfi)
        || (typeof draft.location === 'string' && draft.location)
        || '';
      if (!cfi) return Promise.resolve<TTSSegmentLocator | null>(null);
      // Pass the current rendered page's text as the chunk anchor so the
      // per-segment search starts at this page's position in the spine.
      const chunkText = currDocTextRef.current;
      return buildEpubLocator(book, cfi, segmentText, chunkText);
    })();

    const stable = await resolvedLocator;
    if (!stable || !isStableEpubLocator(stable)) return null;

    const spineText = await getSpineItemPlainText(book, stable.spineHref);
    const canonical = canonicalizeEpubSegmentAgainstSpineText({
      segmentText,
      spineText,
      spineHref: stable.spineHref,
      spineIndex: stable.spineIndex,
      hintCharOffset: stable.charOffset,
      cfi: stable.cfi,
      keyPrefix: options?.keyPrefix,
      maxBlockLength: options?.maxBlockLength ?? ttsSegmentMaxBlockLength,
    });
    if (!canonical) return null;

    return {
      locator: canonical.locator,
      segmentKey: canonical.segmentKey,
      segmentIndex: canonical.segmentIndex,
      text: canonical.text,
    };
  }, [ttsSegmentMaxBlockLength]);

  const walkUpcomingRenderedLocations = useCallback<EpubRenderedLocationWalker>(async (startCfi, depth, signal) => {
    if (!startCfi || depth <= 0 || signal.aborted) return [];
    const visibleRendition = renditionRef.current;
    if (!currDocData || !visibleRendition || typeof document === 'undefined') return [];

    const visibleSettings = (visibleRendition as unknown as {
      settings?: {
        spread?: string;
      };
      manager?: { stage?: { container?: Element | null }; container?: Element | null };
    }).settings;
    const containerElement =
      (visibleRendition as unknown as { manager?: { stage?: { container?: Element | null }; container?: Element | null } }).manager?.stage?.container
      ?? (visibleRendition as unknown as { manager?: { container?: Element | null } }).manager?.container
      ?? null;
    const bounds = containerElement?.getBoundingClientRect?.();
    const width = Math.max(320, Math.floor(bounds?.width || 900));
    const height = Math.max(320, Math.floor(bounds?.height || 700));

    const visibleContents = typeof visibleRendition.getContents === 'function'
      ? visibleRendition.getContents()
      : [];
    const visibleContent = Array.isArray(visibleContents) ? visibleContents[0] : visibleContents;
    const contentDoc = (visibleContent as { document?: Document | null } | null | undefined)?.document ?? null;
    const contentBody = contentDoc?.body ?? null;
    const bodyStyle = contentBody ? getComputedStyle(contentBody) : null;

    const theme = epubTheme
      ? {
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground'),
        base: getComputedStyle(document.documentElement).getPropertyValue('--base'),
        fontFamily: bodyStyle?.fontFamily || undefined,
        fontSize: bodyStyle?.fontSize || undefined,
        lineHeight: bodyStyle?.lineHeight || undefined,
        fontWeight: bodyStyle?.fontWeight || undefined,
        letterSpacing: bodyStyle?.letterSpacing || undefined,
        wordSpacing: bodyStyle?.wordSpacing || undefined,
      }
      : null;

    return renderedLocationCloneManagerRef.current.walk({
      data: currDocData,
      startCfi,
      depth,
      signal,
      width,
      height,
      spread: visibleSettings?.spread,
      theme,
    });
  }, [currDocData, epubTheme]);

  const { createFullAudioBook, regenerateChapter } = useEPUBAudiobook({
    bookRef,
    tocRef,
    apiKey,
    baseUrl,
    providerRef,
  });

  const setRendition = useCallback((rendition: Rendition) => {
    bookRef.current = rendition.book;
    renditionRef.current = rendition;
  }, []);

  const handleLocationChanged = useEPUBLocationController({
    documentId,
    authEnabled,
    isEpubSetOnceRef: isEPUBSetOnce,
    shouldPauseRef,
    setIsEpub: setIsEPUB,
    skipToLocation,
    extractPageText,
    bookRef,
    renditionRef,
    locationRef,
  });



  return useMemo(
    () => ({
      setCurrentDocument,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      clearCurrDoc,
      extractPageText,
      walkUpcomingRenderedLocations,
      resolveEpubLocator,
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
      clearCurrDoc,
      extractPageText,
      walkUpcomingRenderedLocations,
      resolveEpubLocator,
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
