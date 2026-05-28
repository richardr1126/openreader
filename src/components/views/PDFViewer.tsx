'use client';

import { RefObject, useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { Document, Page } from 'react-pdf';
import type { Dest } from 'react-pdf/src/shared/types.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { usePDFResize } from '@/hooks/pdf/usePDFResize';
import type { PdfDocumentState } from '@/app/(app)/pdf/[id]/usePdfDocument';
import type { ParsedPdfBlock, ParsedPdfPage } from '@/types/parsed-pdf';

interface PDFViewerProps {
  zoomLevel: number;
  onDocumentReady?: () => void;
  pdfState: Pick<
    PdfDocumentState,
    | 'highlightPattern'
    | 'clearHighlights'
    | 'clearWordHighlights'
    | 'highlightWordIndex'
    | 'onDocumentLoadSuccess'
    | 'currDocId'
    | 'currDocData'
    | 'currDocPages'
    | 'currDocText'
    | 'currDocPage'
    | 'parsedDocument'
    | 'parsedOverlayEnabled'
  >;
}

interface PDFOnLinkClickArgs {
  pageNumber?: number;
  dest?: Dest;
}

export function PDFViewer({ zoomLevel, onDocumentReady, pdfState }: PDFViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPageRendering, setIsPageRendering] = useState(false);
  const hasSignaledReadyRef = useRef(false);
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
    currentSegment,
    skipToLocation,
  } = useTTS();

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
    parsedDocument,
    parsedOverlayEnabled,
  } = pdfState;

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

  const markViewerReady = useCallback(() => {
    if (hasSignaledReadyRef.current) return;
    hasSignaledReadyRef.current = true;
    onDocumentReady?.();
  }, [onDocumentReady]);

  useEffect(() => {
    hasSignaledReadyRef.current = false;
  }, [currDocId, currDocData]);

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
    return () => {
      clearHighlights();
      clearWordHighlights();
    };
  }, [clearHighlights, clearWordHighlights]);

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

    // Root-cause guard: do not repaint highlights while react-pdf is still
    // replacing page/text layers for a new page or viewport layout.
    if (isPageRendering) {
      return;
    }

    const seq = ++sentenceHighlightSeqRef.current;
    const isLayoutChange = layoutKey !== lastSentenceLayoutKeyRef.current;
    lastSentenceLayoutKeyRef.current = layoutKey;
    const activeLocator = currentSegment?.ownerLocator ?? null;
    const hasParsedBlockLocator =
      !!parsedDocument
      && activeLocator?.readerType === 'pdf'
      && typeof activeLocator.blockId === 'string'
      && activeLocator.blockId.length > 0;

    if (isLayoutChange || !hasParsedBlockLocator) {
      clearHighlights();
    }

    if (!hasParsedBlockLocator) {
      return;
    }

    const useBlockGeometryOnly = !pdfWordHighlightEnabled;

    const tryApply = (attempt: number) => {
      if (seq !== sentenceHighlightSeqRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      if (!useBlockGeometryOnly) {
        const spans = container.querySelectorAll('.react-pdf__Page__textContent span');
        if (!spans.length) {
          if (attempt < 1) scheduleSentenceTimeout(() => tryApply(attempt + 1), 90);
          return;
        }
      }

      highlightPattern(currDocText, currentSentence, containerRef as RefObject<HTMLDivElement>, {
        parsedDocument,
        locator: activeLocator,
        useBlockGeometryOnly,
      });
    };

    scheduleSentenceTimeout(() => tryApply(0), useBlockGeometryOnly ? 80 : 120);

    return () => {
      clearSentenceHighlightTimeouts();
    };
  }, [
    currDocText,
    currentSentence,
    currentSegment,
    highlightPattern,
    clearHighlights,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    parsedDocument,
    layoutKey,
    isPageRendering,
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

    if (isPageRendering) {
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
    scheduleWordTimeout,
    isPageRendering
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

  const parsedPageByNumber = useMemo(() => {
    const map = new Map<number, ParsedPdfPage>();
    for (const page of parsedDocument?.pages ?? []) {
      map.set(page.pageNumber, page);
    }
    return map;
  }, [parsedDocument]);

  const parsedOverlayByPage = useMemo(() => {
    const map = new Map<number, Array<{
      block: ParsedPdfBlock;
      fragment: ParsedPdfBlock['fragments'][number];
      isContinuation: boolean;
    }>>();

    const seen = new Set<string>();
    for (const page of parsedDocument?.pages ?? []) {
      for (const block of page.blocks) {
        for (let fragmentIndex = 0; fragmentIndex < block.fragments.length; fragmentIndex += 1) {
          const fragment = block.fragments[fragmentIndex];
          if (!fragment) continue;
          const key = `${block.id}:${fragment.page}:${fragment.readingOrder}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const list = map.get(fragment.page) ?? [];
          list.push({
            block,
            fragment,
            isContinuation: fragmentIndex > 0,
          });
          map.set(fragment.page, list);
        }
      }
    }

    for (const list of map.values()) {
      const geoKey = (entry: {
        block: ParsedPdfBlock;
        fragment: ParsedPdfBlock['fragments'][number];
        isContinuation: boolean;
      }): string => {
        const [x0, y0, x1, y1] = entry.fragment.bbox;
        const round = (value: number) => Math.round(value * 10) / 10;
        return [
          entry.block.kind,
          round(x0),
          round(y0),
          round(x1),
          round(y1),
        ].join(':');
      };

      const continuationGeometry = new Set<string>();
      for (const entry of list) {
        if (entry.isContinuation) {
          continuationGeometry.add(geoKey(entry));
        }
      }

      const filtered = list.filter((entry) => {
        if (entry.isContinuation) return true;
        return !continuationGeometry.has(geoKey(entry));
      });

      list.length = 0;
      list.push(...filtered);

      list.sort((a, b) => {
        if (a.fragment.readingOrder !== b.fragment.readingOrder) {
          return a.fragment.readingOrder - b.fragment.readingOrder;
        }
        return a.block.id.localeCompare(b.block.id);
      });
    }

    return map;
  }, [parsedDocument]);

  const colorForKind = (kind: ParsedPdfBlock['kind']): string => {
    switch (kind) {
      case 'paragraph_title': return 'rgba(34,197,94,0.20)';
      case 'doc_title': return 'rgba(16,185,129,0.20)';
      case 'figure_title': return 'rgba(245,158,11,0.20)';
      case 'table': return 'rgba(59,130,246,0.20)';
      case 'chart':
      case 'image': return 'rgba(139,92,246,0.20)';
      case 'header':
      case 'footer':
      case 'footnote':
      case 'vision_footnote': return 'rgba(239,68,68,0.20)';
      case 'formula':
      case 'formula_number': return 'rgba(251,146,60,0.22)';
      case 'abstract':
      case 'algorithm':
      case 'aside_text':
      case 'content':
      case 'reference':
      case 'reference_content':
      case 'text':
      case 'number': return 'rgba(14,165,233,0.18)';
      default: return 'rgba(14,165,233,0.18)';
    }
  };

  const renderParsedOverlay = (pageNumber: number) => {
    if (!parsedOverlayEnabled) return null;
    const parsedPage = parsedPageByNumber.get(pageNumber);
    if (!parsedPage) return null;
    const overlayEntries = parsedOverlayByPage.get(pageNumber) ?? [];
    return (
      <div className="pointer-events-none absolute inset-0 z-20">
        {overlayEntries.map(({ block, fragment, isContinuation }) => {
          const [x0, y0, x1, y1] = fragment.bbox;
          const width = parsedPage.width || 1;
          const height = parsedPage.height || 1;
          const leftPct = (x0 / width) * 100;
          const boxWidthPct = Math.max(0, ((x1 - x0) / width) * 100);
          // Parsed model bboxes are top-left based; use y0 directly.
          const topPct = (y0 / height) * 100;
          const boxHeightPct = Math.max(0, ((y1 - y0) / height) * 100);

          return (
            <div
              key={`${block.id}:${fragment.page}:${fragment.readingOrder}`}
              className="absolute border border-accent/70 rounded-[2px]"
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: `${boxWidthPct}%`,
                height: `${boxHeightPct}%`,
                backgroundColor: colorForKind(block.kind),
              }}
            >
              <span className="absolute -top-4 left-0 bg-black/75 text-white text-[10px] px-1 rounded-sm">
                {isContinuation ? `${block.kind} (cont)` : block.kind}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center overflow-auto w-full px-6 h-full pdf-viewer"
    >
      <Document
        key={currDocId || 'pdf'}
        loading={null}
        noData={null}
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
                <div key={`page_wrap_${i + 1}`} className="relative">
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
                      markViewerReady();
                    }}
                    onLoadSuccess={(page) => {
                      setPageWidth(page.originalWidth);
                      setPageHeight(page.originalHeight);
                    }}
                  />
                  {renderParsedOverlay(i + 1)}
                </div>
              ))}
            </div>
          ) : (
            // Single/Dual page mode
            <div className="flex justify-center gap-4">
              {currDocPages && leftPage > 0 && (
                <div className="relative">
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
                      markViewerReady();
                    }}
                    onLoadSuccess={(page) => {
                      setPageWidth(page.originalWidth);
                      setPageHeight(page.originalHeight);
                    }}
                  />
                  {renderParsedOverlay(leftPage)}
                </div>
              )}
              {currDocPages && rightPage && rightPage <= currDocPages && viewType === 'dual' && (
                <div className="relative">
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
                      markViewerReady();
                    }}
                    onLoadSuccess={(page) => {
                      setPageWidth(page.originalWidth);
                      setPageHeight(page.originalHeight);
                    }}
                  />
                  {renderParsedOverlay(rightPage)}
                </div>
              )}
            </div>
          )}
        </div>
      </Document>
    </div>
  );
}
