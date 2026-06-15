/**
 * Route-local PDF document hook.
 *
 * This module owns PDF document loading, text extraction, highlighting, and
 * audiobook integration for the `/pdf/[id]` route.
 */

'use client';

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  RefObject,
  useRef,
} from 'react';

import type { PDFDocumentProxy } from 'pdfjs-dist';

import {
  ensureParsedPdfDocumentOperation,
  forceReparsePdfDocument,
  getParsedPdfDocument,
  ParsedPdfNotReadyError,
  subscribeParsedPdfDocumentEvents,
} from '@/lib/client/api/documents';
import { createPdfAudiobookSourceAdapter } from '@/lib/client/audiobooks/adapters/pdf';
import { regenerateAudiobookChapter, runAudiobookGeneration } from '@/lib/client/audiobooks/pipeline';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import {
  highlightPattern,
  clearHighlights,
  clearWordHighlights,
  highlightWordIndex,
} from '@/lib/client/pdf';
import { buildPageTextFromBlocks } from '@/lib/client/pdf-block-text';
import { buildPdfPageSourceUnits, buildPdfPrefetchPayload } from '@/lib/client/pdf-tts-planning';
import type { CanonicalTtsSourceUnit } from '@/lib/shared/tts-segment-plan';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
} from '@/types/document-settings';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import type { ParsedPdfDocument, ParsedPdfPage, PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';

import type {
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type { AudiobookGenerationSettings, TTSSegmentLocator } from '@/types/client';
import { clampSegmentPreloadDepth } from '@/types/config';
import { useDocumentSettings } from '@/hooks/useDocumentSettings';
import type { BaseDocument } from '@/types/documents';

/**
 * Outcome of a `setCurrentDocument` call.
 * - `loaded`: the document was fetched and is now the active document.
 * - `superseded`: the load was aborted/replaced by a newer load (or unmount).
 *    A newer load is authoritative; callers must NOT treat this as an error.
 * - `failed`: a genuine failure (not found, wrong type, network error).
 */
export type SetCurrentDocumentResult = 'loaded' | 'superseded' | 'failed';

/**
 * Interface defining all available methods and properties for the PDF route.
 */
export interface PdfDocumentState {
  // Current document state
  currDocId: string | undefined;
  currDocData: ArrayBuffer | undefined;
  currDocName: string | undefined;
  currDocPages: number | undefined;
  currDocPage: number;
  currDocText: string | undefined;
  isPlaybackReady: boolean;
  pdfDocument: PDFDocumentProxy | undefined;
  parsedDocument: ParsedPdfDocument | null;
  parseStatus: PdfParseStatus | null;
  parseProgress: PdfParseProgress | null;
  documentSettings: DocumentSettings;
  updateDocumentSettings: (settings: DocumentSettings) => Promise<void>;
  parsedOverlayEnabled: boolean;
  setParsedOverlayEnabled: (enabled: boolean) => void;
  forceReparseParsedPdf: () => Promise<void>;
  setCurrentDocument: (metadata: BaseDocument) => Promise<SetCurrentDocumentResult>;
  clearCurrDoc: () => void;

  // PDF functionality
  onDocumentLoadSuccess: (pdf: PDFDocumentProxy) => void;
  highlightPattern: (
    text: string,
    pattern: string,
    containerRef: RefObject<HTMLDivElement>,
    options?: {
      parsedDocument?: ParsedPdfDocument | null;
      locator?: TTSSegmentLocator | null;
      useBlockGeometryOnly?: boolean;
      language?: string;
    },
  ) => void;
  clearHighlights: () => void;
  clearWordHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    sentence: string | null | undefined,
    containerRef: RefObject<HTMLDivElement>
  ) => void;
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
  isAudioCombining: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main PDF route hook.
 */
export function usePdfDocument(documentId?: string): PdfDocumentState {
  const {
    setText: setTTSText,
    stop,
    currDocPageNumber,
    currDocPages,
    setCurrDocPages,
    setIsEPUB,
    setDocumentLanguage,
    registerVisualPageChangeHandler,
  } = useTTS();
  const {
    providerRef,
    segmentPreloadDepthPages,
    ttsSegmentMaxBlockLength,
  } = useConfig();

  // Current document state
  const [currDocId, setCurrDocId] = useState<string>();
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [parsedDocument, setParsedDocument] = useState<ParsedPdfDocument | null>(null);
  const [parseStatus, setParseStatus] = useState<PdfParseStatus | null>(null);
  const [parseProgress, setParseProgress] = useState<PdfParseProgress | null>(null);
  const [, setActiveParseOpId] = useState<string | null>(null);
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(DEFAULT_DOCUMENT_SETTINGS);
  const serverDocumentSettings = useDocumentSettings(documentId);
  useEffect(() => {
    if (!serverDocumentSettings.query.data?.settings) return;
    setDocumentSettings(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, serverDocumentSettings.query.data.settings));
  }, [serverDocumentSettings.query.data?.settings]);
  useEffect(() => {
    setDocumentLanguage(documentSettings.language ?? 'auto');
    lastPreparedPlaybackPageRef.current = null;
  }, [documentSettings.language, setDocumentLanguage]);
  const [parsedOverlayEnabled, setParsedOverlayEnabled] = useState(false);
  const [isAudioCombining] = useState(false);
  const audiobookAdapter = useMemo(() => createPdfAudiobookSourceAdapter({
    parsed: parsedDocument ?? undefined,
    settings: documentSettings,
    maxBlockLength: ttsSegmentMaxBlockLength,
  }), [parsedDocument, documentSettings, ttsSegmentMaxBlockLength]);
  const pageTextCacheRef = useRef<Map<number, string>>(new Map());
  const [currDocPage, setCurrDocPage] = useState<number>(currDocPageNumber);

  // Used to cancel/ignore in-flight text extraction when the document changes
  // or when react-pdf tears down and recreates its internal worker.
  const pdfDocGenerationRef = useRef(0);
  const pdfDocumentRef = useRef<PDFDocumentProxy | undefined>(undefined);
  const loadSeqRef = useRef(0);

  // Guards for setCurrentDocument to prevent stale loads from overwriting newer selections.
  const docLoadSeqRef = useRef(0);
  const docLoadAbortRef = useRef<AbortController | null>(null);
  const parseStreamAbortRef = useRef<AbortController | null>(null);
  const parseSseCloseRef = useRef<(() => void) | null>(null);
  const lastPreparedPlaybackPageRef = useRef<number | null>(null);

  const loadParsedDocumentOnce = useCallback(async (
    documentId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) return;
    const parsed = await getParsedPdfDocument(documentId, { signal });
    if (signal.aborted) return;
    setParsedDocument(parsed);
    setParseStatus('ready');
    setParseProgress(null);
    setActiveParseOpId(null);
  }, []);

  const resetParsedDocumentState = useCallback(() => {
    setParsedDocument(null);
    setCurrDocText(undefined);
    setIsPlaybackReady(false);
    lastPreparedPlaybackPageRef.current = null;
    pageTextCacheRef.current.clear();
  }, []);

  const startParsedEventStream = useCallback((documentId: string, initialOpId: string) => {
    parseStreamAbortRef.current?.abort();
    parseSseCloseRef.current?.();
    parseSseCloseRef.current = null;
    setParseProgress(null);
    setActiveParseOpId(initialOpId.trim() || null);
    const controller = new AbortController();
    parseStreamAbortRef.current = controller;
    let isResolvingTerminalState = false;

    const closeSse = subscribeParsedPdfDocumentEvents(documentId, {
      opId: initialOpId.trim(),
    }, {
      onSnapshot: (snapshot) => {
        if (controller.signal.aborted) return;
        if (isResolvingTerminalState) return;
        if (typeof snapshot.opId === 'string' && snapshot.opId.trim()) {
          setActiveParseOpId(snapshot.opId.trim());
        }
        setParseStatus(snapshot.parseStatus);
        setParseProgress(snapshot.parseProgress);
        if (snapshot.parseStatus === 'ready') {
          isResolvingTerminalState = true;
          void (async () => {
            let loaded = false;
            let retryMs = 500;
            while (!controller.signal.aborted && !loaded) {
              try {
                await loadParsedDocumentOnce(documentId, controller.signal);
                loaded = true;
              } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.warn('Parsed PDF reported ready before artifact was readable; retrying:', error);
                await delay(retryMs);
                retryMs = Math.min(retryMs * 2, 2_000);
              }
            }
            if (loaded) {
              if (parseSseCloseRef.current === closeSse) {
                closeSse();
                parseSseCloseRef.current = null;
              }
              if (parseStreamAbortRef.current === controller) {
                parseStreamAbortRef.current = null;
              }
            }
          })();
          return;
        }
        if (snapshot.parseStatus === 'failed') {
          isResolvingTerminalState = true;
          closeSse();
          parseSseCloseRef.current = null;
          if (parseStreamAbortRef.current === controller) {
            parseStreamAbortRef.current = null;
          }
          resetParsedDocumentState();
          setActiveParseOpId(null);
          return;
        }
      },
      onError: () => {
        // EventSource reconnects automatically. Keep stream open, but log so
        // production debugging can correlate UI stalls with SSE churn.
        if (controller.signal.aborted) return;
        console.warn('[pdf] parsed/events stream error; waiting for auto-reconnect', {
          documentId,
        });
      },
    });
    parseSseCloseRef.current = closeSse;

    controller.signal.addEventListener('abort', () => {
      closeSse();
      if (parseSseCloseRef.current === closeSse) {
        parseSseCloseRef.current = null;
      }
      if (parseStreamAbortRef.current === controller) {
        parseStreamAbortRef.current = null;
      }
    }, { once: true });
  }, [loadParsedDocumentOnce, resetParsedDocumentState, setActiveParseOpId]);

  const resolveParsedDocumentState = useCallback(async (
    documentId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      await loadParsedDocumentOnce(documentId, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof ParsedPdfNotReadyError)) {
        throw error;
      }

      resetParsedDocumentState();
      setParseStatus(error.parseStatus);
      setParseProgress(error.parseProgress);
      setActiveParseOpId(error.opId);

      if (error.parseStatus === 'failed') {
        return;
      }

      let nextOpId = error.opId;
      let nextStatus: PdfParseStatus = error.parseStatus;
      let nextProgress = error.parseProgress;

      if (!nextOpId) {
        const ensured = await ensureParsedPdfDocumentOperation(documentId, { signal });
        if (signal.aborted) return;
        nextOpId = ensured.opId;
        nextStatus = ensured.parseStatus;
        nextProgress = ensured.parseProgress;
        setParseStatus(nextStatus);
        setParseProgress(nextProgress);
        setActiveParseOpId(nextOpId);
      }

      if (nextStatus === 'ready') {
        await loadParsedDocumentOnce(documentId, signal);
        return;
      }

      if (nextStatus === 'failed' || !nextOpId) {
        return;
      }

      startParsedEventStream(documentId, nextOpId);
    }
  }, [
    loadParsedDocumentOnce,
    resetParsedDocumentState,
    setActiveParseOpId,
    startParsedEventStream,
  ]);

  useEffect(() => {
    pdfDocumentRef.current = pdfDocument;
  }, [pdfDocument]);

  useEffect(() => {
    pageTextCacheRef.current.clear();
  }, [parsedDocument, documentSettings.pdf?.skipBlockKinds]);

  useEffect(() => {
    setCurrDocPage(currDocPageNumber);
    setIsPlaybackReady(false);
  }, [currDocPageNumber]);

  /**
   * Handles successful PDF document load
   * 
   * @param {PDFDocumentProxy} pdf - The loaded PDF document proxy object
   */
  const onDocumentLoadSuccess = useCallback((pdf: PDFDocumentProxy) => {
    pdfDocGenerationRef.current += 1;
    pdfDocumentRef.current = pdf;
    setCurrDocPages(pdf.numPages);
    setPdfDocument(pdf);
  }, [setCurrDocPages, setPdfDocument]);

  /**
   * Loads and processes text from the current document page
   * Uses parsed PDF blocks only and updates both document text and TTS text states.
   * 
   * @returns {Promise<void>}
   */
  const loadCurrDocText = useCallback(async () => {
    try {
      const generation = pdfDocGenerationRef.current;
      const currentPdf = pdfDocumentRef.current;
      if (!currentPdf) return;
      const seq = ++loadSeqRef.current;
      const pageNumber = currDocPageNumber;
      setIsPlaybackReady(false);

      const pageFromParsed = (pageNum: number): ParsedPdfPage | undefined =>
        parsedDocument?.pages.find((page) => page.pageNumber === pageNum);

      if (parseStatus !== 'ready' || !parsedDocument) {
        lastPreparedPlaybackPageRef.current = null;
        setCurrDocText(undefined);
        setTTSText('', { location: currDocPageNumber });
        return;
      }

      const sourceUnitsFromParsedPage = (pageNum: number): CanonicalTtsSourceUnit[] => {
        const page = pageFromParsed(pageNum);
        return buildPdfPageSourceUnits(page, pageNum, documentSettings.pdf?.skipBlockKinds ?? []);
      };

      const getPageText = async (pageNumber: number, shouldCache = false): Promise<string> => {
        // Ignore stale/in-flight work if the document or worker changed.
        if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
          throw new DOMException('Stale PDF extraction', 'AbortError');
        }

        if (pageTextCacheRef.current.has(pageNumber)) {
          const cached = pageTextCacheRef.current.get(pageNumber)!;
          if (!shouldCache) {
            pageTextCacheRef.current.delete(pageNumber);
          }
          return cached;
        }

        const parsedPage = pageFromParsed(pageNumber);
        const extracted = parsedPage
          ? buildPageTextFromBlocks(parsedPage, documentSettings.pdf?.skipBlockKinds ?? [])
          : '';

        if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
          throw new DOMException('Stale PDF extraction', 'AbortError');
        }

        if (shouldCache) {
          pageTextCacheRef.current.set(pageNumber, extracted);
        }
        return extracted;
      };

      const totalPages = currDocPages ?? currentPdf.numPages;
      const prevPageNumber = currDocPageNumber > 1 ? currDocPageNumber - 1 : undefined;
      const nextPageNumber = currDocPageNumber < totalPages ? currDocPageNumber + 1 : undefined;
      const preloadDepth = clampSegmentPreloadDepth(segmentPreloadDepthPages);
      const upcomingPageNumbers: number[] = [];
      for (let offset = 1; offset <= preloadDepth; offset += 1) {
        const pageNum = currDocPageNumber + offset;
        if (pageNum > totalPages) break;
        upcomingPageNumbers.push(pageNum);
      }

      const [text, prevText, ...upcomingTexts] = await Promise.all([
        getPageText(currDocPageNumber),
        prevPageNumber ? getPageText(prevPageNumber) : Promise.resolve<string | undefined>(undefined),
        ...upcomingPageNumbers.map((pageNum) => getPageText(pageNum, true)),
      ]);
      const {
        nextText,
        nextSourceUnits,
        additionalUpcoming,
      } = buildPdfPrefetchPayload(
        upcomingPageNumbers,
        upcomingTexts,
        sourceUnitsFromParsedPage,
      );

      if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
        return;
      }
      if (seq !== loadSeqRef.current || pageNumber !== currDocPageNumber) {
        return;
      }

      const shouldPreparePlayback = text === '' || text !== currDocText || lastPreparedPlaybackPageRef.current !== currDocPageNumber;
      if (shouldPreparePlayback) {
        setCurrDocText(text);
        const sourceUnits = sourceUnitsFromParsedPage(currDocPageNumber);
        setTTSText(text, {
          location: currDocPageNumber,
          previousText: prevText,
          nextLocation: nextPageNumber,
          nextText: nextText,
          nextSourceUnits,
          upcomingLocations: additionalUpcoming,
          ...(sourceUnits.length > 0 ? { sourceUnits } : {}),
        });
      }
      lastPreparedPlaybackPageRef.current = currDocPageNumber;
      setIsPlaybackReady(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('Error loading PDF text:', error);
    }
  }, [
    currDocPageNumber,
    currDocPages,
    setTTSText,
    currDocText,
    segmentPreloadDepthPages,
    parsedDocument,
    parseStatus,
    documentSettings,
  ]);

  /**
   * Effect hook to update document text when the page changes
   * Triggers text extraction and processing when either the document URL or page changes
   */
  useEffect(() => {
    if (currDocData && pdfDocument) {
      loadCurrDocText();
    }
  }, [currDocPageNumber, currDocData, pdfDocument, loadCurrDocText]);

  /**
   * Sets the current document based on its ID
   * Retrieves document from server metadata and the browser blob cache.
   * 
   * @param {BaseDocument} meta - Resolved server metadata for the document
   * @returns {Promise<void>}
   */
  const setCurrentDocument = useCallback(async (meta: BaseDocument): Promise<SetCurrentDocumentResult> => {
    const id = meta.id;
    // --- race-condition guard ---
    const seq = ++docLoadSeqRef.current;
    docLoadAbortRef.current?.abort();
    const controller = new AbortController();
    docLoadAbortRef.current = controller;

    try {
      // Reset any state tied to the previously loaded PDF. This prevents calling
      // `getPage()` on a stale/destroyed PDFDocumentProxy after login redirects
      // or fast refresh.
      pdfDocGenerationRef.current += 1;
      loadSeqRef.current += 1;
      parseStreamAbortRef.current?.abort();
      parseStreamAbortRef.current = null;
      parseSseCloseRef.current?.();
      parseSseCloseRef.current = null;
      pageTextCacheRef.current.clear();
      setPdfDocument(undefined);
      setCurrDocPages(undefined);
      setCurrDocText(undefined);
      setIsPlaybackReady(false);
      lastPreparedPlaybackPageRef.current = null;
      setCurrDocId(id);
      setCurrDocName(undefined);
      setCurrDocData(undefined);
      setParsedDocument(null);
      setParseStatus(null);
      setParseProgress(null);
      setActiveParseOpId(null);
      setDocumentSettings(mergeDocumentSettings(
        DEFAULT_DOCUMENT_SETTINGS,
        serverDocumentSettings.query.data?.settings,
      ));

      if (meta.type !== 'pdf') {
        console.error('Document is not a PDF');
        return 'failed';
      }
      void resolveParsedDocumentState(id, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        console.error('Failed to resolve parsed PDF state:', error);
      });

      const doc = await ensureCachedDocument(meta, { signal: controller.signal });
      if (seq !== docLoadSeqRef.current) return 'superseded'; // a newer load took over
      if (doc.type !== 'pdf') {
        console.error('Document is not a PDF');
        return 'failed';
      }

      setCurrDocName(doc.name);
      // IMPORTANT: keep an immutable copy. pdf.js may transfer/detach the
      // buffer passed into the worker; we always pass clones to react-pdf.
      setCurrDocData(doc.data.slice(0));
      return 'loaded';
    } catch (error) {
      // An aborted load means a newer selection (or unmount) took over; not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return 'superseded';
      if (controller.signal.aborted) return 'superseded';
      console.error('Failed to get document:', error);
      return 'failed';
    } finally {
      // Clean up the controller only if it's still ours (a newer call hasn't replaced it).
      if (docLoadAbortRef.current === controller) {
        docLoadAbortRef.current = null;
      }
    }
  }, [
    setCurrDocId,
    setCurrDocName,
    setCurrDocData,
    setCurrDocPages,
    setCurrDocText,
    setPdfDocument,
    resolveParsedDocumentState,
    serverDocumentSettings.query.data?.settings,
  ]);

  const updateDocumentSettings = useCallback(async (settings: DocumentSettings): Promise<void> => {
    if (!currDocId) return;
    setDocumentSettings(settings);
    try {
      await serverDocumentSettings.mutation.mutateAsync(settings);
    } catch (error) {
      console.warn('Failed to persist document settings:', error);
    }
  }, [currDocId, serverDocumentSettings.mutation]);

  const forceReparseParsedPdf = useCallback(async (): Promise<void> => {
    if (!currDocId) return;
    try {
      const forced = await forceReparsePdfDocument(currDocId);
      loadSeqRef.current += 1;
      pageTextCacheRef.current.clear();
      setParsedDocument(null);
      setCurrDocText(undefined);
      setIsPlaybackReady(false);
      lastPreparedPlaybackPageRef.current = null;
      setParseStatus(forced.status);
      setParseProgress(null);
      setActiveParseOpId(forced.opId ?? null);
      if (forced.opId) {
        startParsedEventStream(currDocId, forced.opId);
      }
    } catch (error) {
      console.error('Failed to force PDF reparse:', error);
    }
  }, [currDocId, startParsedEventStream]);

  /**
   * Clears the current document state
   * Resets all document-related states and stops any ongoing TTS playback
   */
  const clearCurrDoc = useCallback(() => {
    pdfDocGenerationRef.current += 1;
    pdfDocumentRef.current = undefined;
    loadSeqRef.current += 1;
    // Invalidate any in-flight setCurrentDocument load.
    docLoadSeqRef.current += 1;
    docLoadAbortRef.current?.abort();
    docLoadAbortRef.current = null;
    parseStreamAbortRef.current?.abort();
    parseStreamAbortRef.current = null;
    parseSseCloseRef.current?.();
    parseSseCloseRef.current = null;
    setCurrDocId(undefined);
    setCurrDocName(undefined);
    setCurrDocData(undefined);
    setCurrDocText(undefined);
    setIsPlaybackReady(false);
    setCurrDocPages(undefined);
    setPdfDocument(undefined);
    setParsedDocument(null);
    setParseStatus(null);
    setParseProgress(null);
    setActiveParseOpId(null);
    setDocumentSettings(DEFAULT_DOCUMENT_SETTINGS);
    lastPreparedPlaybackPageRef.current = null;
    pageTextCacheRef.current.clear();
    stop();
  }, [setCurrDocId, setCurrDocName, setCurrDocData, setCurrDocPages, setCurrDocText, setPdfDocument, stop]);

  /**
   * Creates a complete audiobook by processing all PDF pages through NLP and TTS
   * @param {Function} onProgress - Callback for progress updates
   * @param {AbortSignal} signal - Optional signal for cancellation
   * @param {Function} onChapterComplete - Optional callback for when a chapter completes
   * @returns {Promise<string>} The bookId for the generated audiobook
   */
  const createFullAudioBook = useCallback(async (
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    onChapterComplete?: (chapter: TTSAudiobookChapter) => void,
    providedBookId?: string,
    format: TTSAudiobookFormat = 'mp3',
    settings?: AudiobookGenerationSettings
  ): Promise<string> => {
    try {
      return await runAudiobookGeneration({
        adapter: audiobookAdapter,
        defaultProvider: providerRef,
        onProgress,
        signal,
        onChapterComplete,
        providedBookId,
        format,
        settings,
      });
    } catch (error) {
      console.error('Error creating audiobook:', error);
      throw error;
    }
  }, [audiobookAdapter, providerRef]);

  /**
   * Regenerates a specific chapter (page) of the PDF audiobook
   */
  const regenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    format: TTSAudiobookFormat,
    signal: AbortSignal,
    settings?: AudiobookGenerationSettings
  ): Promise<TTSAudiobookChapter> => {
    try {
      return await regenerateAudiobookChapter({
        adapter: audiobookAdapter,
        chapterIndex,
        bookId,
        format,
        signal,
        defaultProvider: providerRef,
        settings,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
        throw new Error('Page regeneration cancelled');
      }
      console.error('Error regenerating page:', error);
      throw error;
    }
  }, [audiobookAdapter, providerRef]);

  /**
   * Effect hook to initialize TTS as non-EPUB mode
   */
  useEffect(() => {
    setIsEPUB(false);
  }, [setIsEPUB]);

  useEffect(() => {
    registerVisualPageChangeHandler(location => {
      if (typeof location !== 'number') return;
      if (!pdfDocument) return;
      const totalPages = currDocPages ?? pdfDocument.numPages;
      const clamped = Math.min(Math.max(location, 1), totalPages);
      setCurrDocPage(clamped);
    });
    return () => {
      registerVisualPageChangeHandler(null);
    };
  }, [registerVisualPageChangeHandler, currDocPages, pdfDocument]);

  return useMemo(
    () => ({
      onDocumentLoadSuccess,
      setCurrentDocument,
      currDocId,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      isPlaybackReady,
      parsedDocument,
      parseStatus,
      parseProgress,
      documentSettings,
      updateDocumentSettings,
      parsedOverlayEnabled,
      setParsedOverlayEnabled,
      forceReparseParsedPdf,
      clearCurrDoc,
      highlightPattern,
      clearHighlights,
      clearWordHighlights,
      highlightWordIndex,
      pdfDocument,
      createFullAudioBook,
      regenerateChapter,
      isAudioCombining,
    }),
    [
      onDocumentLoadSuccess,
      setCurrentDocument,
      currDocId,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      isPlaybackReady,
      parsedDocument,
      parseStatus,
      parseProgress,
      documentSettings,
      updateDocumentSettings,
      parsedOverlayEnabled,
      setParsedOverlayEnabled,
      forceReparseParsedPdf,
      clearCurrDoc,
      pdfDocument,
      createFullAudioBook,
      regenerateChapter,
      isAudioCombining,
    ]
  );
}
