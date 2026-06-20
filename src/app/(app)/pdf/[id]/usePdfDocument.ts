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
import { buildPageTextFromBlocks } from '@openreader/tts/pdf-sources';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
} from '@/types/document-settings';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import type { ParsedPdfDocument, ParsedPdfPage, PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import { useParsedPdfDocument } from '@/hooks/useParsedPdfDocument';

import type {
  TTSSentenceAlignment,
  TTSAudiobookFormat,
  TTSAudiobookChapter,
} from '@/types/tts';
import type { AudiobookGenerationSettings, TTSSegmentLocator } from '@/types/client';
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

/**
 * Main PDF route hook.
 */
export function usePdfDocument(
  documentId: string | undefined,
  serverDocumentSettings: DocumentSettings | null,
  persistDocumentSettings: (settings: DocumentSettings) => Promise<unknown>,
): PdfDocumentState {
  const {
    setText: setTTSText,
    stop,
    currDocPageNumber,
    currDocPages,
    setCurrDocPages,
    setIsEPUB,
    setDocumentLanguage,
  } = useTTS();
  const {
    providerRef,
    ttsSegmentMaxBlockLength,
  } = useConfig();
  const parsedPdf = useParsedPdfDocument(documentId);

  // Current document state
  const [currDocId, setCurrDocId] = useState<string>();
  const [currDocData, setCurrDocData] = useState<ArrayBuffer>();
  const [currDocName, setCurrDocName] = useState<string>();
  const [currDocText, setCurrDocText] = useState<string>();
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const parsedDocument = parsedPdf.query.data?.document ?? null;
  const parseStatus = parsedPdf.query.data?.parseStatus ?? (parsedPdf.query.isError ? 'failed' : null);
  const parseProgress = parsedPdf.query.data?.parseProgress ?? null;
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(DEFAULT_DOCUMENT_SETTINGS);
  useEffect(() => {
    if (!serverDocumentSettings) return;
    setDocumentSettings(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, serverDocumentSettings));
  }, [serverDocumentSettings]);
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
  const [currDocPage, setCurrDocPage] = useState<number>(currDocPageNumber);

  // Used to cancel/ignore in-flight text extraction when the document changes
  // or when react-pdf tears down and recreates its internal worker.
  const pdfDocGenerationRef = useRef(0);
  const pdfDocumentRef = useRef<PDFDocumentProxy | undefined>(undefined);
  const loadSeqRef = useRef(0);

  // Guards for setCurrentDocument to prevent stale loads from overwriting newer selections.
  const docLoadSeqRef = useRef(0);
  const docLoadAbortRef = useRef<AbortController | null>(null);
  const lastPreparedPlaybackPageRef = useRef<number | null>(null);

  useEffect(() => {
    pdfDocumentRef.current = pdfDocument;
  }, [pdfDocument]);

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

      const getPageText = async (pageNumber: number): Promise<string> => {
        // Ignore stale/in-flight work if the document or worker changed.
        if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
          throw new DOMException('Stale PDF extraction', 'AbortError');
        }

        const parsedPage = pageFromParsed(pageNumber);
        const extracted = parsedPage
          ? buildPageTextFromBlocks(parsedPage, documentSettings.pdf?.skipBlockKinds ?? [])
          : '';

        if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
          throw new DOMException('Stale PDF extraction', 'AbortError');
        }

        return extracted;
      };

      const text = await getPageText(currDocPageNumber);

      if (generation !== pdfDocGenerationRef.current || pdfDocumentRef.current !== currentPdf) {
        return;
      }
      if (seq !== loadSeqRef.current || pageNumber !== currDocPageNumber) {
        return;
      }

      const shouldPreparePlayback = text === '' || text !== currDocText || lastPreparedPlaybackPageRef.current !== currDocPageNumber;
      if (shouldPreparePlayback) {
        setCurrDocText(text);
        setTTSText(text, {
          location: currDocPageNumber,
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
      setPdfDocument(undefined);
      setCurrDocPages(undefined);
      setCurrDocText(undefined);
      setIsPlaybackReady(false);
      lastPreparedPlaybackPageRef.current = null;
      setCurrDocId(id);
      setCurrDocName(undefined);
      setCurrDocData(undefined);
      setDocumentSettings(mergeDocumentSettings(
        DEFAULT_DOCUMENT_SETTINGS,
        serverDocumentSettings,
      ));

      if (meta.type !== 'pdf') {
        console.error('Document is not a PDF');
        return 'failed';
      }
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
    serverDocumentSettings,
  ]);

  const updateDocumentSettings = useCallback(async (settings: DocumentSettings): Promise<void> => {
    if (!currDocId) return;
    setDocumentSettings(settings);
    try {
      await persistDocumentSettings(settings);
    } catch (error) {
      console.warn('Failed to persist document settings:', error);
    }
  }, [currDocId, persistDocumentSettings]);

  const forceReparseParsedPdf = useCallback(async (): Promise<void> => {
    if (!currDocId) return;
    try {
      await parsedPdf.forceReparseMutation.mutateAsync();
      loadSeqRef.current += 1;
      setCurrDocText(undefined);
      setIsPlaybackReady(false);
      lastPreparedPlaybackPageRef.current = null;
    } catch (error) {
      console.error('Failed to force PDF reparse:', error);
    }
  }, [currDocId, parsedPdf.forceReparseMutation]);

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
    setCurrDocId(undefined);
    setCurrDocName(undefined);
    setCurrDocData(undefined);
    setCurrDocText(undefined);
    setIsPlaybackReady(false);
    setCurrDocPages(undefined);
    setPdfDocument(undefined);
    setDocumentSettings(DEFAULT_DOCUMENT_SETTINGS);
    lastPreparedPlaybackPageRef.current = null;
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

  // The local currDocPage is a read-only mirror of the TTS context page (synced
  // by the effect above). The context is the single source of truth: manual
  // navigation calls skipToLocation (which sets the context page) and playback
  // advances the context page directly as audio crosses page boundaries, so the
  // viewer always turns. There is no independent local page setter to diverge.

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
