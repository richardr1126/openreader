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

import { getDocumentMetadata } from '@/lib/client/api/documents';
import { createPdfAudiobookSourceAdapter } from '@/lib/client/audiobooks/adapters/pdf';
import { regenerateAudiobookChapter, runAudiobookGeneration } from '@/lib/client/audiobooks/pipeline';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import {
  extractTextFromPDF,
  highlightPattern,
  clearHighlights,
  clearWordHighlights,
  highlightWordIndex,
} from '@/lib/client/pdf';

import type {
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
import { clampSegmentPreloadDepth } from '@/types/config';

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
  pdfDocument: PDFDocumentProxy | undefined;
  setCurrentDocument: (id: string) => Promise<void>;
  clearCurrDoc: () => void;

  // PDF functionality
  onDocumentLoadSuccess: (pdf: PDFDocumentProxy) => void;
  highlightPattern: (text: string, pattern: string, containerRef: RefObject<HTMLDivElement>) => void;
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

const EMPTY_TEXT_RETRY_DELAY_MS = 120;
const EMPTY_TEXT_MAX_RETRIES = 6;

/**
 * Main PDF route hook.
 */
export function usePdfDocument(): PdfDocumentState {
  const {
    setText: setTTSText,
    stop,
    currDocPageNumber,
    currDocPages,
    setCurrDocPages,
    setIsEPUB,
    registerVisualPageChangeHandler,
  } = useTTS();
  const {
    headerMargin,
    footerMargin,
    leftMargin,
    rightMargin,
    apiKey,
    baseUrl,
    providerRef,
    smartSentenceSplitting,
    segmentPreloadDepthPages,
    ttsSegmentMaxBlockLength,
  } = useConfig();

  // Current document state
  const [currDocId, setCurrDocId] = useState<string>();
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [isAudioCombining] = useState(false);
  const audiobookAdapter = useMemo(() => createPdfAudiobookSourceAdapter({
    pdfDocument,
    margins: {
      header: headerMargin,
      footer: footerMargin,
      left: leftMargin,
      right: rightMargin,
    },
    smartSentenceSplitting,
    maxBlockLength: ttsSegmentMaxBlockLength,
  }), [pdfDocument, headerMargin, footerMargin, leftMargin, rightMargin, smartSentenceSplitting, ttsSegmentMaxBlockLength]);
  const pageTextCacheRef = useRef<Map<number, string>>(new Map());
  const [currDocPage, setCurrDocPage] = useState<number>(currDocPageNumber);

  // Used to cancel/ignore in-flight text extraction when the document changes
  // or when react-pdf tears down and recreates its internal worker.
  const pdfDocGenerationRef = useRef(0);
  const pdfDocumentRef = useRef<PDFDocumentProxy | undefined>(undefined);
  const loadSeqRef = useRef(0);
  const emptyRetryRef = useRef<{ page: number; attempt: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);

  // Guards for setCurrentDocument to prevent stale loads from overwriting newer selections.
  const docLoadSeqRef = useRef(0);
  const docLoadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    pdfDocumentRef.current = pdfDocument;
  }, [pdfDocument]);

  useEffect(() => {
    setCurrDocPage(currDocPageNumber);
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
   * Extracts text from the PDF and updates both document text and TTS text states
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

      const existingRetry = emptyRetryRef.current;
      if (existingRetry?.timer) {
        clearTimeout(existingRetry.timer);
      }
      emptyRetryRef.current =
        existingRetry && existingRetry.page === pageNumber
          ? { ...existingRetry, timer: null }
          : null;

      const margins = {
        header: headerMargin,
        footer: footerMargin,
        left: leftMargin,
        right: rightMargin
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

        const extracted = await extractTextFromPDF(currentPdf, pageNumber, margins);

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
      const nextText = upcomingTexts[0];
      const additionalUpcoming = upcomingPageNumbers
        .slice(1)
        .map((pageNum, idx) => ({
          location: pageNum,
          text: upcomingTexts[idx + 1] || '',
        }))
        .filter((item) => item.text.trim().length > 0);

      if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
        return;
      }
      if (seq !== loadSeqRef.current || pageNumber !== currDocPageNumber) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        const prevAttempt = emptyRetryRef.current?.page === pageNumber ? emptyRetryRef.current.attempt : 0;
        const attempt = prevAttempt + 1;

        // Avoid pushing empty text into TTS immediately; transient empty extractions can happen
        // during page turns or react-pdf worker churn. Retry a few times before treating it as
        // a truly blank page.
        if (attempt <= EMPTY_TEXT_MAX_RETRIES) {
          const timer = setTimeout(() => {
            if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
              return;
            }
            if (pageNumber !== currDocPageNumber) {
              return;
            }
            void loadCurrDocText();
          }, EMPTY_TEXT_RETRY_DELAY_MS);

          emptyRetryRef.current = { page: pageNumber, attempt, timer };
          return;
        }
      } else {
        emptyRetryRef.current = null;
      }

      if (text !== currDocText || text === '') {
        setCurrDocText(text);
        setTTSText(text, {
          location: currDocPageNumber,
          previousText: prevText,
          nextLocation: nextPageNumber,
          nextText: nextText,
          upcomingLocations: additionalUpcoming,
        });
      }
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
    headerMargin,
    footerMargin,
    leftMargin,
    rightMargin,
    segmentPreloadDepthPages,
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
   * Retrieves document from IndexedDB
   * 
   * @param {string} id - The unique identifier of the document to set
   * @returns {Promise<void>}
   */
  const setCurrentDocument = useCallback(async (id: string): Promise<void> => {
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
      if (emptyRetryRef.current?.timer) {
        clearTimeout(emptyRetryRef.current.timer);
      }
      emptyRetryRef.current = null;
      pageTextCacheRef.current.clear();
      setPdfDocument(undefined);
      setCurrDocPages(undefined);
      setCurrDocText(undefined);
      setCurrDocId(id);
      setCurrDocName(undefined);
      setCurrDocData(undefined);

      const meta = await getDocumentMetadata(id, { signal: controller.signal });
      if (seq !== docLoadSeqRef.current) return; // stale
      if (!meta) {
        console.error('Document not found on server');
        return;
      }

      const doc = await ensureCachedDocument(meta, { signal: controller.signal });
      if (seq !== docLoadSeqRef.current) return; // stale
      if (doc.type !== 'pdf') {
        console.error('Document is not a PDF');
        return;
      }

      setCurrDocName(doc.name);
      // IMPORTANT: keep an immutable copy. pdf.js may transfer/detach the
      // buffer passed into the worker; we always pass clones to react-pdf.
      setCurrDocData(doc.data.slice(0));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Failed to get document:', error);
    } finally {
      // Clean up the controller only if it's still ours (a newer call hasn't replaced it).
      if (docLoadAbortRef.current === controller) {
        docLoadAbortRef.current = null;
      }
    }
  }, [setCurrDocId, setCurrDocName, setCurrDocData, setCurrDocPages, setCurrDocText, setPdfDocument]);

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
    if (emptyRetryRef.current?.timer) {
      clearTimeout(emptyRetryRef.current.timer);
    }
    emptyRetryRef.current = null;
    setCurrDocId(undefined);
    setCurrDocName(undefined);
    setCurrDocData(undefined);
    setCurrDocText(undefined);
    setCurrDocPages(undefined);
    setPdfDocument(undefined);
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
        apiKey,
        baseUrl,
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
  }, [audiobookAdapter, apiKey, baseUrl, providerRef]);

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
        apiKey,
        baseUrl,
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
  }, [audiobookAdapter, apiKey, baseUrl, providerRef]);

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
      clearCurrDoc,
      pdfDocument,
      createFullAudioBook,
      regenerateChapter,
      isAudioCombining,
    ]
  );
}
