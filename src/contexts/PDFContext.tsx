/**
 * PDF Context Provider
 * 
 * This module provides a React context for managing PDF document functionality.
 * It handles document loading, text extraction, highlighting, and integration with TTS.
 * 
 * Key features:
 * - PDF document management (add/remove/load)
 * - Text extraction and processing
 * - Text highlighting and navigation
 * - Document state management
 */

'use client';

import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useCallback,
  useMemo,
  RefObject,
  useRef,
} from 'react';

import type { PDFDocumentProxy } from 'pdfjs-dist';

import { getDocumentMetadata } from '@/lib/client/api/documents';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { normalizeTextForTts } from '@/lib/shared/nlp';
import { withRetry, getAudiobookStatus, generateTTS, createAudiobookChapter } from '@/lib/client/api/audiobooks';
import {
  extractTextFromPDF,
  highlightPattern,
  clearHighlights,
  clearWordHighlights,
  highlightWordIndex,
} from '@/lib/client/pdf';

import type {
  TTSSentenceAlignment,
  TTSAudioBuffer,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type {
  TTSRequestHeaders,
  TTSRequestPayload,
  TTSRetryOptions,
  AudiobookGenerationSettings,
} from '@/types/client';

/**
 * Interface defining all available methods and properties in the PDF context
 */
interface PDFContextType {
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

// Create the context
const PDFContext = createContext<PDFContextType | undefined>(undefined);

const EMPTY_TEXT_RETRY_DELAY_MS = 120;
const EMPTY_TEXT_MAX_RETRIES = 6;

/**
 * PDFProvider Component
 * 
 * Main provider component that manages PDF state and functionality.
 * Handles document loading, text processing, and integration with TTS.
 * 
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 */
export function PDFProvider({ children }: { children: ReactNode }) {
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
    voiceSpeed,
    voice,
    ttsProvider,
    ttsModel,
    ttsInstructions,
    smartSentenceSplitting,
  } = useConfig();

  // Current document state
  const [currDocId, setCurrDocId] = useState<string>();
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [isAudioCombining] = useState(false);
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
    console.log('Document loaded:', pdf.numPages);
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
      const nextPageNumber = currDocPageNumber < totalPages ? currDocPageNumber + 1 : undefined;

      const [text, nextText] = await Promise.all([
        getPageText(currDocPageNumber),
        nextPageNumber ? getPageText(nextPageNumber, true) : Promise.resolve<string | undefined>(undefined),
      ]);

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
          nextLocation: nextPageNumber,
          nextText: nextText,
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
      if (!pdfDocument) {
        throw new Error('No PDF document loaded');
      }

      const effectiveProvider = settings?.ttsProvider ?? ttsProvider;
      const effectiveModel = settings?.ttsModel ?? ttsModel;
      const effectiveVoice =
        settings?.voice ||
        voice ||
        (effectiveProvider === 'openai'
          ? 'alloy'
          : effectiveProvider === 'deepinfra'
            ? 'af_bella'
            : 'af_sarah');
      const effectiveNativeSpeed = settings?.nativeSpeed ?? voiceSpeed;
      const effectiveFormat = settings?.format ?? format;

      // First pass: extract and measure all text
      const textPerPage: string[] = [];
      let totalLength = 0;

      for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
        const rawText = await extractTextFromPDF(pdfDocument, pageNum, {
          header: headerMargin,
          footer: footerMargin,
          left: leftMargin,
          right: rightMargin
        });
        const trimmedText = rawText.trim();
        if (trimmedText) {
          const processedText = smartSentenceSplitting ? normalizeTextForTts(trimmedText) : trimmedText;

          textPerPage.push(processedText);
          totalLength += processedText.length;
        }
      }

      if (totalLength === 0) {
        throw new Error('No text content found in PDF');
      }

      let processedLength = 0;
      let bookId: string = providedBookId || '';

      // If we have a bookId, check for existing chapters to determine which indices already exist
      const existingIndices = new Set<number>();
      if (bookId) {
        try {
          const existingData = await getAudiobookStatus(bookId);
          if (existingData.chapters && existingData.chapters.length > 0) {
            for (const ch of existingData.chapters) {
              existingIndices.add(ch.index);
            }
            let nextMissing = 0;
            while (existingIndices.has(nextMissing)) nextMissing++;
            console.log(`Resuming; next missing page index is ${nextMissing} (page ${nextMissing + 1})`);
          }
        } catch (error) {
          console.error('Error checking existing chapters:', error);
        }
      }

      // Second pass: process text into audio
      for (let i = 0; i < textPerPage.length; i++) {
        // Check for abort at the start of iteration
        if (signal?.aborted) {
          console.log('Generation cancelled by user');
          if (bookId) {
            return bookId; // Return bookId with partial progress
          }
          throw new Error('Audiobook generation cancelled');
        }

        const text = textPerPage[i];

        // Skip pages that already exist on disk (supports non-contiguous indices)
        if (existingIndices.has(i)) {
          processedLength += text.length;
          onProgress((processedLength / totalLength) * 100);
          continue;
        }

        const reqHeaders: TTSRequestHeaders = {
          'Content-Type': 'application/json',
          'x-openai-key': apiKey,
          'x-openai-base-url': baseUrl,
          'x-tts-provider': effectiveProvider,
        };

        const reqBody: TTSRequestPayload = {
          text,
          voice: effectiveVoice,
          speed: effectiveNativeSpeed,
          format: 'mp3',
          model: effectiveModel,
          instructions: effectiveModel === 'gpt-4o-mini-tts' ? ttsInstructions : undefined
        };

        // Allow one narrow client retry for transient browser->/api/tts transport failures.
        // HTTP failures are not retried client-side.
        const retryOptions: TTSRetryOptions = {
          maxRetries: 2,
          initialDelay: 300,
          maxDelay: 300,
        };

        try {
          const audioBuffer = await withRetry(
            async () => {
              // Check for abort before starting TTS request
              if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
              }

              return await generateTTS(reqBody, reqHeaders, signal);
            },
            retryOptions
          );

          const chapterTitle = `Page ${i + 1}`;

          // Check for abort before sending to server
          if (signal?.aborted) {
            console.log('Generation cancelled before saving page');
            if (bookId) {
              return bookId;
            }
            throw new Error('Audiobook generation cancelled');
          }

          // Send to server for conversion and storage
          const chapter = await createAudiobookChapter({
            chapterTitle,
            buffer: Array.from(new Uint8Array(audioBuffer)),
            bookId,
            format: effectiveFormat,
            chapterIndex: i,
            settings
          }, signal);

          if (!bookId) {
            bookId = chapter.bookId!;
          }

          // Notify about completed chapter
          if (onChapterComplete) {
            onChapterComplete(chapter);
          }

          processedLength += text.length;
          onProgress((processedLength / totalLength) * 100);

        } catch (error) {
          if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
            console.log('TTS request aborted, returning partial progress');
            if (bookId) {
              return bookId; // Return with partial progress
            }
            throw new Error('Audiobook generation cancelled');
          }
          console.error('Error processing page:', error);

          // Notify about error
          if (onChapterComplete) {
            onChapterComplete({
              index: i,
              title: `Page ${i + 1}`,
              status: 'error',
              bookId,
              format: effectiveFormat
            });
          }
        }
      }

      if (!bookId) {
        throw new Error('No audio was generated from the PDF content');
      }

      return bookId;
    } catch (error) {
      console.error('Error creating audiobook:', error);
      throw error;
    }
  }, [pdfDocument, headerMargin, footerMargin, leftMargin, rightMargin, apiKey, baseUrl, voice, voiceSpeed, ttsProvider, ttsModel, ttsInstructions, smartSentenceSplitting]);

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
      if (!pdfDocument) {
        throw new Error('No PDF document loaded');
      }

      const effectiveProvider = settings?.ttsProvider ?? ttsProvider;
      const effectiveModel = settings?.ttsModel ?? ttsModel;
      const effectiveVoice =
        settings?.voice ||
        voice ||
        (effectiveProvider === 'openai'
          ? 'alloy'
          : effectiveProvider === 'deepinfra'
            ? 'af_bella'
            : 'af_sarah');
      const effectiveNativeSpeed = settings?.nativeSpeed ?? voiceSpeed;
      const effectiveFormat = settings?.format ?? format;

      // IMPORTANT: Chapter indices are based on non-empty pages used during generation.
      // Build a mapping of "chapterIndex" -> actual PDF page number (1-based).
      const nonEmptyPages: number[] = [];
      for (let page = 1; page <= pdfDocument.numPages; page++) {
        const pageText = await extractTextFromPDF(pdfDocument, page, {
          header: headerMargin,
          footer: footerMargin,
          left: leftMargin,
          right: rightMargin
        });
        if (pageText.trim()) {
          nonEmptyPages.push(page);
        }
      }

      if (chapterIndex < 0 || chapterIndex >= nonEmptyPages.length) {
        throw new Error('Invalid chapter index');
      }

      const pageNum = nonEmptyPages[chapterIndex];

      // Extract text from the mapped page
      const rawText = await extractTextFromPDF(pdfDocument, pageNum, {
        header: headerMargin,
        footer: footerMargin,
        left: leftMargin,
        right: rightMargin
      });

      const trimmedText = rawText.trim();
      if (!trimmedText) {
        throw new Error('No text content found on page');
      }

      const textForTTS = smartSentenceSplitting
        ? normalizeTextForTts(trimmedText)
        : trimmedText;

      // Use logical chapter numbering (index + 1) to match original generation titles
      const chapterTitle = `Page ${chapterIndex + 1}`;

      // Generate audio with retry logic
      const reqHeaders: TTSRequestHeaders = {
        'Content-Type': 'application/json',
        'x-openai-key': apiKey,
        'x-openai-base-url': baseUrl,
        'x-tts-provider': effectiveProvider,
      };

      const reqBody: TTSRequestPayload = {
        text: textForTTS,
        voice: effectiveVoice,
        speed: effectiveNativeSpeed,
        format: 'mp3',
        model: effectiveModel,
        instructions: effectiveModel === 'gpt-4o-mini-tts' ? ttsInstructions : undefined
      };

      // Allow one narrow client retry for transient browser->/api/tts transport failures.
      // HTTP failures are not retried client-side.
      const retryOptions: TTSRetryOptions = {
        maxRetries: 2,
        initialDelay: 300,
        maxDelay: 300,
      };

      const audioBuffer: TTSAudioBuffer = await withRetry(
        async () => {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          return await generateTTS(reqBody, reqHeaders, signal);
        },
        retryOptions
      );

      if (signal?.aborted) {
        throw new Error('Page regeneration cancelled');
      }

      // Send to server for conversion and storage
      const chapter = await createAudiobookChapter({
        chapterTitle,
        buffer: Array.from(new Uint8Array(audioBuffer)),
        bookId,
        format: effectiveFormat,
        chapterIndex,
        settings
      }, signal);

      return chapter;

    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled'))) {
        throw new Error('Page regeneration cancelled');
      }
      console.error('Error regenerating page:', error);
      throw error;
    }
  }, [pdfDocument, headerMargin, footerMargin, leftMargin, rightMargin, apiKey, baseUrl, voice, voiceSpeed, ttsProvider, ttsModel, ttsInstructions, smartSentenceSplitting]);

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
  }, [registerVisualPageChangeHandler, currDocPages, pdfDocument]);

  // Context value memoization
  const contextValue = useMemo(
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

  return (
    <PDFContext.Provider value={contextValue}>
      {children}
    </PDFContext.Provider>
  );
}

/**
 * Custom hook to consume the PDF context
 * Ensures the context is used within a provider
 * 
 * @throws {Error} If used outside of PDFProvider
 * @returns {PDFContextType} The PDF context value containing all PDF-related functionality
 */
export function usePDF() {
  const context = useContext(PDFContext);
  if (context === undefined) {
    throw new Error('usePDF must be used within a PDFProvider');
  }
  return context;
}
