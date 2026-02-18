'use client';

import { RefObject, useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { Document, Page } from 'react-pdf';
import type { Dest } from 'react-pdf/src/shared/types.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { useTTS } from '@/contexts/TTSContext';
import { usePDF } from '@/contexts/PDFContext';
import { useConfig } from '@/contexts/ConfigContext';
import { usePDFResize } from '@/hooks/pdf/usePDFResize';

interface PDFViewerProps {
  zoomLevel: number;
}

interface PDFOnLinkClickArgs {
  pageNumber?: number;
  dest?: Dest;
}

export function PDFViewer({ zoomLevel }: PDFViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPageRendering, setIsPageRendering] = useState(false);
  const scaleRef = useRef<number>(1);
  const { containerWidth, containerHeight } = usePDFResize(containerRef);
  const sentenceHighlightSeqRef = useRef(0);
  const wordHighlightSeqRef = useRef(0);
  const sentenceHighlightTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const wordHighlightTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastSentenceLayoutKeyRef = useRef<string>('');
  const lastWordLayoutKeyRef = useRef<string>('');

  // Config context
  const { viewType, pdfHighlightEnabled, pdfWordHighlightEnabled } = useConfig();

  // TTS context
  const {
    currentSentence,
    currentWordIndex,
    currentSentenceAlignment,
    skipToLocation,
  } = useTTS();

  // PDF context
  const {
    highlightPattern,
    clearHighlights,
    clearWordHighlights,
    highlightWordIndex,
    onDocumentLoadSuccess,
    currDocId,
    currDocData,
    currDocPages,
    currDocText,
    currDocPage,
  } = usePDF();

  // IMPORTANT:
  // - pdf.js may transfer/detach ArrayBuffers when sending them to its worker, so we must clone.
  // - react-pdf warns if `file` changes by reference but is deep-equal to the previous value.
  // We use useMemo to create a stable file object that only changes when currDocId or currDocData changes.
  const documentFile = useMemo(() => {
    if (!currDocId || !currDocData) return undefined;
    try {
      return { data: new Uint8Array(currDocData.slice(0)) };
    } catch (e) {
      console.error('Failed to prepare PDF data for viewer:', e);
      return undefined;
    }
  }, [currDocId, currDocData]);

  const layoutKey = `${zoomLevel}:${containerWidth}:${containerHeight}:${viewType}:${currDocPage}`;

  // Track page turns so we can keep the previous canvas visible until the new one paints.
  const lastRenderedLayoutKeyRef = useRef<string>('');
  useEffect(() => {
    if (layoutKey !== lastRenderedLayoutKeyRef.current) {
      setIsPageRendering(true);
    }
  }, [layoutKey]);

  const clearSentenceHighlightTimeouts = useCallback(() => {
    for (const t of sentenceHighlightTimeoutsRef.current) clearTimeout(t);
    sentenceHighlightTimeoutsRef.current = [];
  }, []);

  const clearWordHighlightTimeouts = useCallback(() => {
    for (const t of wordHighlightTimeoutsRef.current) clearTimeout(t);
    wordHighlightTimeoutsRef.current = [];
  }, []);

  const scheduleSentenceTimeout = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    sentenceHighlightTimeoutsRef.current.push(t);
  }, []);

  const scheduleWordTimeout = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    wordHighlightTimeoutsRef.current.push(t);
  }, []);

  useEffect(() => {
    /*
     * Handles highlighting the current sentence being read by TTS.
     * Includes a small delay for smooth highlighting and cleans up on unmount.
     * 
     * Dependencies:
     * - pdfText: Re-run when the text content changes
     * - currentSentence: Re-run when the TTS position changes
     * - highlightPattern: Function from context that could change
     * - clearHighlights: Function from context that could change
     */

    if (!currDocText || !pdfHighlightEnabled) {
      clearHighlights();
      return;
    }

    clearSentenceHighlightTimeouts();

    if (!currentSentence) {
      // Cancel any in-flight retry loops and ensure stale highlights don't remain
      // when the current sentence becomes null/undefined.
      sentenceHighlightSeqRef.current += 1;
      clearHighlights();
      return;
    }

    const seq = ++sentenceHighlightSeqRef.current;
    const isLayoutChange = layoutKey !== lastSentenceLayoutKeyRef.current;
    lastSentenceLayoutKeyRef.current = layoutKey;

    if (isLayoutChange) {
      clearHighlights();
    }

    const tryApply = (attempt: number) => {
      if (seq !== sentenceHighlightSeqRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      const spans = container.querySelectorAll('.react-pdf__Page__textContent span');
      if (!spans.length) {
        if (attempt < 10) scheduleSentenceTimeout(() => tryApply(attempt + 1), 75);
        return;
      }

      highlightPattern(currDocText, currentSentence, containerRef as RefObject<HTMLDivElement>);
    };

    scheduleSentenceTimeout(() => tryApply(0), 200);

    return () => {
      clearSentenceHighlightTimeouts();
      clearHighlights();
    };
  }, [
    currDocText,
    currentSentence,
    highlightPattern,
    clearHighlights,
    pdfHighlightEnabled,
    layoutKey,
    clearSentenceHighlightTimeouts,
    scheduleSentenceTimeout
  ]);

  // Word-level highlight layered on top of the block highlight
  useEffect(() => {
    clearWordHighlightTimeouts();

    if (!pdfHighlightEnabled || !pdfWordHighlightEnabled) {
      clearWordHighlights();
      return;
    }

    if (!currentSentence || currentWordIndex === null || currentWordIndex === undefined || currentWordIndex < 0) {
      clearWordHighlights();
      return;
    }

    const wordEntry =
      currentSentenceAlignment && currentWordIndex < currentSentenceAlignment.words.length
        ? currentSentenceAlignment.words[currentWordIndex]
        : undefined;
    const wordText = wordEntry?.text || null;

    if (!wordText) {
      clearWordHighlights();
      return;
    }

    const seq = ++wordHighlightSeqRef.current;
    const isLayoutChange = layoutKey !== lastWordLayoutKeyRef.current;
    lastWordLayoutKeyRef.current = layoutKey;

    const tryApplyWord = (attempt: number) => {
      if (seq !== wordHighlightSeqRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      highlightWordIndex(
        currentSentenceAlignment,
        currentWordIndex,
        currentSentence || '',
        containerRef as RefObject<HTMLDivElement>
      );

      if (isLayoutChange) {
        // If we don't see a word overlay yet, the sentence highlight worker may not
        // have produced `lastSentenceTokenWindow` (or the text layer isn't ready).
        const overlayCount = container.querySelectorAll('.pdf-word-highlight-overlay').length;
        if (overlayCount === 0 && attempt < 12) {
          scheduleWordTimeout(() => tryApplyWord(attempt + 1), 75);
        }
      }
    };

    const cleanup = () => {
      clearWordHighlightTimeouts();
    };

    if (isLayoutChange) {
      clearWordHighlights();
      scheduleWordTimeout(() => tryApplyWord(0), 250);
      return cleanup;
    }

    tryApplyWord(0);
    return cleanup;
  }, [
    currentWordIndex,
    currentSentence,
    currentSentenceAlignment,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    clearWordHighlights,
    highlightWordIndex,
    layoutKey,
    clearWordHighlightTimeouts,
    scheduleWordTimeout
  ]);

  // Add page dimensions state
  const [pageWidth, setPageWidth] = useState<number>(595); // default A4 width
  const [pageHeight, setPageHeight] = useState<number>(842); // default A4 height

  // Calculate which pages to show based on viewType
  const leftPage = viewType === 'dual'
    ? (currDocPage % 2 === 0 ? currDocPage - 1 : currDocPage)
    : currDocPage;
  const rightPage = viewType === 'dual'
    ? (currDocPage % 2 === 0 ? currDocPage : currDocPage + 1)
    : null;

  // Modify scale calculation to be more efficient
  const calculateScale = useCallback((width = pageWidth, height = pageHeight): number => {
    const margin = viewType === 'dual' ? 48 : 24; // adjust margin based on view type
    const effectiveContainerHeight = containerHeight || (containerRef.current?.clientHeight ?? window.innerHeight);
    const targetWidth = viewType === 'dual'
      ? (containerWidth - margin) / 2 // divide by 2 for dual pages
      : containerWidth - margin;
    const targetHeight = effectiveContainerHeight - margin;

    if (viewType === 'scroll') {
      // For scroll mode, use a more comfortable width-based scale
      // Use 75% of the width-based scale to make it less zoomed in
      const scaleByWidth = (targetWidth / width) * 0.75;
      return scaleByWidth * (zoomLevel / 100);
    }

    const scaleByWidth = targetWidth / width;
    const scaleByHeight = targetHeight / height;

    const baseScale = Math.min(scaleByWidth, scaleByHeight);
    return baseScale * (zoomLevel / 100);
  }, [containerWidth, containerHeight, zoomLevel, pageWidth, pageHeight, viewType]);

  // Add memoized scale to prevent unnecessary recalculations
  const currentScale = useCallback(() => {
    const newScale = calculateScale();
    if (Math.abs(newScale - scaleRef.current) > 0.01) {
      scaleRef.current = newScale;
    }
    return scaleRef.current;
  }, [calculateScale]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center overflow-auto w-full px-6 h-full pdf-viewer"
    >
      <Document
        key={currDocId || 'pdf'}
        loading={<DocumentSkeleton />}
        noData={<DocumentSkeleton />}
        file={documentFile}
        onLoadSuccess={(pdf) => {
          onDocumentLoadSuccess(pdf);
        }}
        onItemClick={(args: PDFOnLinkClickArgs) => {
          if (args?.pageNumber) {
            skipToLocation(args.pageNumber, true);
          } else if (args?.dest) {
            const destArray = args.dest as Array<number> || [];
            const pageNum = destArray[0] + 1 || null;
            if (pageNum) {
              skipToLocation(pageNum, true);
            }
          }
        }}
        className="flex flex-col items-center m-0 z-0"
      >
        <div className="pdf-page-stage" data-rendering={isPageRendering ? 'true' : 'false'}>
          {viewType === 'scroll' ? (
            // Scroll mode: render all pages
            <div className="flex flex-col gap-4">
              {currDocPages && [...Array(currDocPages)].map((_, i) => (
                <Page
                  key={`page_${i + 1}`}
                  pageNumber={i + 1}
                  renderAnnotationLayer={true}
                  renderTextLayer={i + 1 === currDocPage}
                  className="shadow-lg"
                  scale={currentScale()}
                  onRenderSuccess={() => {
                    lastRenderedLayoutKeyRef.current = layoutKey;
                    setIsPageRendering(false);
                  }}
                  onLoadSuccess={(page) => {
                    setPageWidth(page.originalWidth);
                    setPageHeight(page.originalHeight);
                  }}
                />
              ))}
            </div>
          ) : (
            // Single/Dual page mode
            <div className="flex justify-center gap-4">
              {currDocPages && leftPage > 0 && (
                <Page
                  key={`page_${leftPage}`}
                  pageNumber={leftPage}
                  renderAnnotationLayer={true}
                  renderTextLayer={leftPage === currDocPage}
                  className="shadow-lg"
                  scale={currentScale()}
                  onRenderSuccess={() => {
                    lastRenderedLayoutKeyRef.current = layoutKey;
                    setIsPageRendering(false);
                  }}
                  onLoadSuccess={(page) => {
                    setPageWidth(page.originalWidth);
                    setPageHeight(page.originalHeight);
                  }}
                />
              )}
              {currDocPages && rightPage && rightPage <= currDocPages && viewType === 'dual' && (
                <Page
                  key={`page_${rightPage}`}
                  pageNumber={rightPage}
                  renderAnnotationLayer={true}
                  renderTextLayer={rightPage === currDocPage}
                  className="shadow-lg"
                  scale={currentScale()}
                  onRenderSuccess={() => {
                    lastRenderedLayoutKeyRef.current = layoutKey;
                    setIsPageRendering(false);
                  }}
                  onLoadSuccess={(page) => {
                    setPageWidth(page.originalWidth);
                    setPageHeight(page.originalHeight);
                  }}
                />
              )}
            </div>
          )}
        </div>
      </Document>
    </div>
  );
}
