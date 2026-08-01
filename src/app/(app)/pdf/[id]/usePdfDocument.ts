/**
 * Route-local PDF document hook.
 *
 * This module owns the loaded PDF's renderer proxy, text extraction,
 * highlighting, and playback anchors for the `/pdf/[id]` route. Immutable
 * source acquisition is owned by the shared reader bootstrap hook.
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

import { useTTS } from '@/contexts/TTSContext';
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
import type { ParsedPdfDocument, ParsedPdfPage } from '@/types/parsed-pdf';

import type {
  TTSSentenceAlignment,
} from '@/types/tts';
import type { TTSSegmentLocator } from '@/types/client';
import type { PDFDocument } from '@/types/documents';

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
  documentSettings: DocumentSettings;
  updateDocumentSettings: (settings: DocumentSettings) => Promise<void>;
  parsedOverlayEnabled: boolean;
  setParsedOverlayEnabled: (enabled: boolean) => void;

  // PDF functionality
  onDocumentLoadSuccess: (pdf: PDFDocumentProxy) => void;
  highlightPattern: (
    pattern: string,
    containerRef: RefObject<HTMLDivElement>,
    options?: {
      parsedDocument?: ParsedPdfDocument | null;
      locator?: TTSSegmentLocator | null;
      useBlockGeometryOnly?: boolean;
      language?: string;
    },
  ) => boolean;
  clearHighlights: () => void;
  clearWordHighlights: () => void;
  highlightWordIndex: (
    alignment: TTSSentenceAlignment | undefined,
    wordIndex: number | null | undefined,
    sentence: string | null | undefined,
    containerRef: RefObject<HTMLDivElement>
  ) => void;
}

/**
 * Main PDF route hook.
 */
export function usePdfDocument(
  document: PDFDocument,
  serverDocumentSettings: DocumentSettings | null,
  parsedDocument: ParsedPdfDocument,
  persistDocumentSettings: (settings: DocumentSettings) => Promise<unknown>,
): PdfDocumentState {
  const {
    setDocumentPlaybackAnchor,
    currDocPageNumber,
    currDocPages,
    setCurrDocPages,
  } = useTTS();
  const currDocId = document.id;
  const currDocData = document.data;
  const currDocName = document.name;
  const [currDocText, setCurrDocText] = useState<string>();
  const [isPlaybackReady, setIsPlaybackReady] = useState(false);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(() => (
    mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, serverDocumentSettings)
  ));
  useEffect(() => {
    if (!serverDocumentSettings) return;
    setDocumentSettings(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, serverDocumentSettings));
  }, [serverDocumentSettings]);
  const [parsedOverlayEnabled, setParsedOverlayEnabled] = useState(false);
  const currDocPage = currDocPageNumber;

  // Used to cancel/ignore in-flight text extraction when the document changes
  // or when react-pdf tears down and recreates its internal worker.
  const pdfDocGenerationRef = useRef(0);
  const pdfDocumentRef = useRef<PDFDocumentProxy | undefined>(undefined);
  const loadSeqRef = useRef(0);

  const lastPreparedPlaybackPageRef = useRef<number | null>(null);

  useEffect(() => {
    pdfDocumentRef.current = pdfDocument;
  }, [pdfDocument]);

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
        setDocumentPlaybackAnchor(currDocPageNumber, Boolean(text.trim()));
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
    setDocumentPlaybackAnchor,
    currDocText,
    parsedDocument,
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

  const updateDocumentSettings = useCallback(async (settings: DocumentSettings): Promise<void> => {
    if (!currDocId) return;
    setDocumentSettings(settings);
    try {
      await persistDocumentSettings(settings);
    } catch (error) {
      console.warn('Failed to persist document settings:', error);
    }
  }, [currDocId, persistDocumentSettings]);

  return useMemo(
    () => ({
      onDocumentLoadSuccess,
      currDocId,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      isPlaybackReady,
      parsedDocument,
      documentSettings,
      updateDocumentSettings,
      parsedOverlayEnabled,
      setParsedOverlayEnabled,
      highlightPattern,
      clearHighlights,
      clearWordHighlights,
      highlightWordIndex,
      pdfDocument,
    }),
    [
      onDocumentLoadSuccess,
      currDocId,
      currDocData,
      currDocName,
      currDocPages,
      currDocPage,
      currDocText,
      isPlaybackReady,
      parsedDocument,
      documentSettings,
      updateDocumentSettings,
      parsedOverlayEnabled,
      setParsedOverlayEnabled,
      pdfDocument,
    ]
  );
}
