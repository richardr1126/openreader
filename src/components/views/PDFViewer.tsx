'use client';

import { RefObject, useCallback, useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Document, Page } from 'react-pdf';
import type { Dest, OnPageLoadSuccess } from 'react-pdf/src/shared/types.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useTTS, useTTSHighlight } from '@/contexts/TTSContext';
import { useReaderAppearance } from '@/contexts/ReaderAppearanceContext';
import { usePDFResize } from '@/hooks/pdf/usePDFResize';
import type { PdfDocumentState } from '@/app/(app)/pdf/[id]/usePdfDocument';
import type { ParsedPdfBlock, ParsedPdfPage } from '@/types/parsed-pdf';
import { pdfBlockSpans, resolvePdfBlockAtPoint } from '@/lib/client/pdf';
import { indexSegmentsBySource, resolvePointInUnit, resolveSelectionInUnits } from '@/lib/client/reader/segment-hit';
import { highlightsOverlapping } from '@/lib/client/reader/bookmarks';
import { paintSavedHighlights } from '@/lib/client/reader/saved-highlights';
import { bindSelectionReporting, useReaderHighlights } from '@/components/reader/ReaderHighlights';
import { bindTapToSeek } from '@/lib/client/reader/tap-to-seek';
import { useLatestRef } from '@/hooks/useLatestRef';
import {
  normalizePdfSegmentText,
  pdfPartWordRange,
  pdfSegmentPageAt,
  resolvePdfSegmentPageParts,
} from '@/lib/client/pdf/segment-pages';
import { pdfLocatorPage } from '@/lib/client/tts/playback-selection';
import { locateAlignmentWordSpans } from '@/lib/client/highlight-token-alignment';

interface PDFViewerProps {
  zoomLevel: number;
  onReady?: () => void;
  onError?: (error: Error) => void;
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

export function PDFViewer({ zoomLevel, onReady, onError, pdfState }: PDFViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollPageRefs = useRef(new Map<number, HTMLDivElement>());
  const scrollSyncedPageRef = useRef<number | null>(null);
  const commandedScrollTopRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [isPageRendering, setIsPageRendering] = useState(false);
  const [textLayerReadyLayoutKey, setTextLayerReadyLayoutKey] = useState('');
  const { containerWidth, containerHeight } = usePDFResize(containerRef);
  const sentenceHighlightSeqRef = useRef(0);
  const wordHighlightSeqRef = useRef(0);
  const wordHighlightTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lastSentenceLayoutKeyRef = useRef<string>('');
  const lastWordLayoutKeyRef = useRef<string>('');

  // Config context
  const { presentation: { viewType, highlightSegment: pdfHighlightEnabled, highlightWords: pdfWordHighlightEnabled } } = useReaderAppearance();

  // TTS context
  const {
    browseToLocation,
    followingNarration,
    followingNarrationRef,
    setFollowingNarration,
    readerNavigationRevision,
    resolvedLanguage,
    playbackPlanReady,
    playbackPlanSegmentCount,
    playbackSegments,
    skipToOrdinal,
    syncPlaybackLocator,
  } = useTTS();
  const {
    currentSentence,
    currentWordIndex,
    currentSentenceAlignment,
    currentSegment,
  } = useTTSHighlight();

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

  // A sentence that runs over a page break is split by page. Narration turns to
  // the page of the word being spoken, and each page highlights only its words.
  const segmentPageParts = useMemo(
    () => resolvePdfSegmentPageParts(
      parsedDocument,
      currentSegment?.ownerLocator,
      currentSentence,
      currentSegment?.startAnchor.sourceKey === currentSegment?.ownerSourceKey
        ? currentSegment?.startAnchor.offset
        : undefined,
    ),
    [parsedDocument, currentSegment, currentSentence],
  );
  // Parts only leave the locator page for a block stitched across a break.
  const locatorPage = pdfLocatorPage(currentSegment?.ownerLocator);
  const leavesLocatorPage = segmentPageParts.some((part) => part.page !== locatorPage);
  const segmentWordSpans = useMemo(
    () => (leavesLocatorPage && currentSentenceAlignment
      ? locateAlignmentWordSpans(currentSentenceAlignment.words, normalizePdfSegmentText(currentSentence), resolvedLanguage)
      : null),
    [leavesLocatorPage, currentSentenceAlignment, currentSentence, resolvedLanguage],
  );
  const spokenWordOffset = currentWordIndex !== null && currentWordIndex !== undefined && currentWordIndex >= 0
    ? segmentWordSpans?.[currentWordIndex]?.start ?? 0
    : 0;
  const spokenPage = leavesLocatorPage ? pdfSegmentPageAt(segmentPageParts, spokenWordOffset) : null;
  const renderedPagePart = segmentPageParts.find((part) => part.page === currDocPage) ?? null;
  // The spoken words this page shows, as a slice of the segment alignment.
  const renderedPageWords = useMemo(() => {
    if (!renderedPagePart || !currentSentenceAlignment) return null;
    if (!segmentWordSpans) return { first: 0, alignment: currentSentenceAlignment };
    const range = pdfPartWordRange(segmentWordSpans, renderedPagePart);
    if (!range) return null;
    return {
      first: range.first,
      alignment: { ...currentSentenceAlignment, words: currentSentenceAlignment.words.slice(range.first, range.last + 1) },
    };
  }, [renderedPagePart, currentSentenceAlignment, segmentWordSpans]);

  const pageWordIndex = (currentWordIndex ?? -1) - (renderedPageWords?.first ?? 0);
  const hasSpokenWord = Boolean(renderedPageWords?.alignment.words[pageWordIndex]?.text);
  const followSpokenWord = followingNarration && hasSpokenWord;

  useLayoutEffect(() => {
    if (!followingNarration || spokenPage === null || spokenPage === currDocPage) return;
    const locator = currentSegment?.ownerLocator;
    if (locator?.readerType !== 'pdf') return;
    syncPlaybackLocator({ ...locator, page: spokenPage });
  }, [currDocPage, currentSegment, followingNarration, spokenPage, syncPlaybackLocator]);

  // Tap a sentence to play from it. Parsed blocks are plan source units, so a
  // tap resolves within the block's own sentences on the rendered text layer.
  const segmentsByBlock = useMemo(() => indexSegmentsBySource(playbackSegments), [playbackSegments]);
  const tapStateRef = useLatestRef({ segmentsByBlock, parsedDocument, resolvedLanguage, skipToOrdinal });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return bindTapToSeek(container, {
      resolve: (point) => {
        const { segmentsByBlock: index, parsedDocument: parsed, resolvedLanguage: language } = tapStateRef.current;
        if (!parsed) return null;
        const unit = resolvePdfBlockAtPoint(container, parsed, point);
        if (!unit) return null;
        return resolvePointInUnit(unit.spans, index.get(unit.sourceKey) ?? [], point, language);
      },
      seek: (ordinal) => {
        tapStateRef.current.skipToOrdinal(ordinal);
      },
    });
  }, [tapStateRef]);

  const { highlights: savedHighlights, declarations: savedDeclarations, selectionSink } = useReaderHighlights();

  // A selection on the text layer offers to highlight the sentences it covers,
  // resolved within each parsed block it crosses.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return bindSelectionReporting(container.ownerDocument, (range) => {
      if (!container.contains(range.commonAncestorContainer)) return null;
      const { segmentsByBlock: index, parsedDocument: parsed, resolvedLanguage: language } = tapStateRef.current;
      if (!parsed) return null;
      const units = new Map<string, HTMLElement[]>();
      for (const span of container.querySelectorAll<HTMLElement>('.react-pdf__Page__textContent span')) {
        if (!range.intersectsNode(span)) continue;
        const rect = span.getBoundingClientRect();
        const unit = resolvePdfBlockAtPoint(container, parsed, {
          clientX: (rect.left + rect.right) / 2,
          clientY: (rect.top + rect.bottom) / 2,
          target: span,
        });
        if (unit && !units.has(unit.sourceKey)) units.set(unit.sourceKey, unit.spans);
      }
      return resolveSelectionInUnits(
        range,
        Array.from(units),
        ([, spans]) => spans,
        ([key]) => index.get(key) ?? [],
        language,
      );
    }, selectionSink);
  }, [selectionSink, tapStateRef]);

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

  // Calculate which pages to show based on viewType
  const leftPage = viewType === 'dual'
    ? (currDocPage % 2 === 0 ? currDocPage - 1 : currDocPage)
    : currDocPage;
  const rightPage = viewType === 'dual'
    ? (currDocPage % 2 === 0 ? currDocPage : currDocPage + 1)
    : null;

  const parsedPageByNumber = useMemo(() => {
    const map = new Map<number, ParsedPdfPage>();
    for (const page of parsedDocument?.pages ?? []) map.set(page.pageNumber, page);
    return map;
  }, [parsedDocument]);
  const [fallbackSize, setFallbackSize] = useState({ width: 595, height: 842 });
  const handlePageLoadSuccess = useCallback<OnPageLoadSuccess>((page) => {
    if (!parsedPageByNumber.has(page.pageNumber)) {
      const { width, height } = page.getViewport({ scale: 1 });
      setFallbackSize({ width, height });
    }
  }, [parsedPageByNumber]);

  // A spread fits as a unit. Keep the same scale when narration moves from
  // one page to the other, even if the pages have different dimensions.
  const leftSize = parsedPageByNumber.get(viewType === 'scroll' ? 1 : leftPage);
  const rightSize = rightPage !== null && rightPage <= (currDocPages ?? 0)
    ? parsedPageByNumber.get(rightPage)
    : null;
  const leftWidth = leftSize?.width || fallbackSize.width;
  const width = viewType === 'dual' ? leftWidth + (rightSize?.width || leftWidth) : leftWidth;
  const height = Math.max(leftSize?.height || fallbackSize.height, rightSize?.height ?? 0);
  const margin = viewType === 'dual' ? 48 : 24;
  const fitWidth = Math.max(0.1, ((containerWidth || width + margin) - margin) / width);
  const fitHeight = Math.max(0.1, ((containerHeight || window.innerHeight) - margin) / height);
  const nextScale = (viewType === 'scroll' ? fitWidth * 0.75 : Math.min(fitWidth, fitHeight)) * zoomLevel / 100;

  // Sub-percent changes keep the rendered scale so the canvas does not repaint.
  const [renderScale, setRenderScale] = useState(nextScale);
  if (Math.abs(nextScale - renderScale) > 0.01) setRenderScale(nextScale);

  function pageSlotSize(pageNumber: number) {
    const page = parsedPageByNumber.get(pageNumber);
    if (!page || page.width <= 0 || page.height <= 0) return undefined;
    // Reserve the canvas footprint before either page renders. In a spread,
    // the right page must keep its position when the left canvas arrives.
    return {
      minWidth: Math.floor(page.width * renderScale),
      minHeight: Math.floor(page.height * renderScale),
    };
  }

  // Renderer readiness follows the props that can actually make React-PDF
  // repaint. Raw container dimensions are deliberately excluded: if they
  // change without changing the stabilized scale, no render callback will fire.
  // Canvases repaint only when the displayed pages change; moving the current
  // page within a spread, or in scroll mode, moves only the text layer.
  const canvasLayoutKey = `${renderScale}:${viewType}:${viewType === 'scroll' ? 'all' : `${leftPage}:${rightPage ?? ''}`}`;
  const layoutKey = `${canvasLayoutKey}:${currDocPage}`;
  const selectedSegmentKey = playbackPlanSegmentCount === 0
    ? 'empty'
    : currentSegment
      ? `${currentSegment.ordinal}:${currentSegment.key}`
      : null;
  const surfaceKey = currDocId && playbackPlanReady && selectedSegmentKey
    ? `${currDocId}:${layoutKey}:${selectedSegmentKey}`
    : null;
  const activeSurfaceKeyRef = useLatestRef(surfaceKey);
  const committedSurfacePartsRef = useRef(new Map<string, Set<'canvas' | 'text' | 'highlight'>>());
  const readySurfaceKeyRef = useRef<string | null>(null);
  const failedSurfaceKeyRef = useRef<string | null>(null);
  const activeLayoutKeyRef = useLatestRef(layoutKey);
  const activeCanvasLayoutKeyRef = useLatestRef(canvasLayoutKey);

  const commitSurfacePart = useCallback((
    key: string | null,
    part: 'canvas' | 'text' | 'highlight',
  ) => {
    if (!key || activeSurfaceKeyRef.current !== key || readySurfaceKeyRef.current) return;
    const parts = committedSurfacePartsRef.current.get(key) ?? new Set();
    parts.add(part);
    committedSurfacePartsRef.current.set(key, parts);
    if (!parts.has('canvas') || !parts.has('text') || !parts.has('highlight')) return;
    readySurfaceKeyRef.current = key;
    onReady?.();
  }, [activeSurfaceKeyRef, onReady]);

  const reportSurfaceCommitError = useCallback((error: Error) => {
    const key = activeSurfaceKeyRef.current;
    if (!key || readySurfaceKeyRef.current || failedSurfaceKeyRef.current === key) return;
    failedSurfaceKeyRef.current = key;
    onError?.(error);
  }, [activeSurfaceKeyRef, onError]);

  // Saved highlights paint on the text layer once it is ready for this layout;
  // narration paints with overlays, so these ranges stay valid until it rebuilds.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !parsedDocument) return;
    if (isPageRendering || textLayerReadyLayoutKey !== layoutKey) return;
    const units = function* () {
      for (const [key, candidates] of segmentsByBlock) {
        if (candidates.length === 0) continue;
        const first = candidates[0].ordinal;
        const last = candidates[candidates.length - 1].ordinal;
        if (highlightsOverlapping(savedHighlights, first, last).length === 0) continue;
        const spans = pdfBlockSpans(container, parsedDocument, key);
        if (spans) yield { roots: spans, candidates };
      }
    };
    paintSavedHighlights(container.ownerDocument, units(), savedHighlights, savedDeclarations, resolvedLanguage);
  }, [
    isPageRendering,
    layoutKey,
    parsedDocument,
    resolvedLanguage,
    savedDeclarations,
    savedHighlights,
    segmentsByBlock,
    textLayerReadyLayoutKey,
  ]);

  // Track page turns so we can keep the previous canvas visible until the new one paints.
  const lastRenderedCanvasLayoutKeyRef = useRef<string>('');
  useEffect(() => {
    if (canvasLayoutKey !== lastRenderedCanvasLayoutKeyRef.current) {
      setIsPageRendering(true);
      return;
    }
    commitSurfacePart(surfaceKey, 'canvas');
  }, [canvasLayoutKey, commitSurfacePart, surfaceKey]);

  // Associate completion with the layout that started the render. An older
  // canvas or text layer can finish while a new spread or zoom is rendering.
  const handlePageRenderSuccess = useCallback(() => {
    if (canvasLayoutKey !== activeCanvasLayoutKeyRef.current) return;
    lastRenderedCanvasLayoutKeyRef.current = canvasLayoutKey;
    setIsPageRendering(false);
    commitSurfacePart(activeSurfaceKeyRef.current, 'canvas');
  }, [activeCanvasLayoutKeyRef, activeSurfaceKeyRef, canvasLayoutKey, commitSurfacePart]);

  const handleTextLayerRenderSuccess = useCallback(() => {
    if (layoutKey !== activeLayoutKeyRef.current) return;
    setTextLayerReadyLayoutKey(layoutKey);
    commitSurfacePart(activeSurfaceKeyRef.current, 'text');
  }, [activeLayoutKeyRef, activeSurfaceKeyRef, commitSurfacePart, layoutKey]);

  useEffect(() => {
    committedSurfacePartsRef.current.clear();
    readySurfaceKeyRef.current = null;
    failedSurfaceKeyRef.current = null;
  }, [currDocId, currDocData]);

  const clearWordHighlightTimeouts = useCallback(() => {
    for (const t of wordHighlightTimeoutsRef.current) clearTimeout(t);
    wordHighlightTimeoutsRef.current = [];
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
    if ((!pdfHighlightEnabled && !pdfWordHighlightEnabled) || playbackPlanSegmentCount === 0) {
      clearHighlights();
      commitSurfacePart(surfaceKey, 'highlight');
      return;
    }

    // An image-only cover can be ready while narration starts on a later
    // page. There is no highlight to paint on this surface, even when its
    // extracted text is empty.
    const activeLocator = currentSegment?.ownerLocator ?? null;
    if (activeLocator?.readerType === 'pdf' && !renderedPagePart) {
      clearHighlights();
      clearWordHighlights();
      commitSurfacePart(surfaceKey, 'highlight');
      return;
    }

    if (!currentSentence || !currentSegment || !currDocText) {
      sentenceHighlightSeqRef.current += 1;
      clearHighlights();
      return;
    }

    // Root-cause guard: do not repaint highlights while react-pdf is still
    // replacing page/text layers for a new page or viewport layout.
    if (isPageRendering || textLayerReadyLayoutKey !== layoutKey) {
      return;
    }

    const seq = ++sentenceHighlightSeqRef.current;
    const isLayoutChange = layoutKey !== lastSentenceLayoutKeyRef.current;
    lastSentenceLayoutKeyRef.current = layoutKey;
    const hasParsedBlockLocator =
      !!parsedDocument
      && activeLocator?.readerType === 'pdf'
      && renderedPagePart !== null
      && typeof activeLocator.blockId === 'string'
      && activeLocator.blockId.length > 0;

    if (isLayoutChange || !hasParsedBlockLocator) {
      clearHighlights();
    }

    if (!hasParsedBlockLocator) {
      reportSurfaceCommitError(
        new Error('The selected worker-plan segment did not contain a PDF block locator.'),
      );
      return;
    }

    const useBlockGeometryOnly = !pdfWordHighlightEnabled;

    try {
      const didCommitHighlight = highlightPattern(
        renderedPagePart.text,
        containerRef as RefObject<HTMLDivElement>,
        {
          parsedDocument,
          locator: { ...activeLocator, page: renderedPagePart.page },
          paintSegment: pdfHighlightEnabled,
          useBlockGeometryOnly,
          language: resolvedLanguage,
          follow: followingNarrationRef.current,
          preferWord: followSpokenWord,
        },
      );
      if (seq !== sentenceHighlightSeqRef.current) return;
      if (activeSurfaceKeyRef.current !== surfaceKey) return;
      if (!didCommitHighlight) {
        reportSurfaceCommitError(
          new Error('The selected worker-plan segment did not map to the rendered PDF surface.'),
        );
        return;
      }
      commitSurfacePart(surfaceKey, 'highlight');
    } catch (error) {
      if (seq !== sentenceHighlightSeqRef.current) return;
      reportSurfaceCommitError(
        error instanceof Error ? error : new Error('Failed to highlight the initial PDF surface.'),
      );
    }
  }, [
    activeSurfaceKeyRef,
    currDocText,
    followingNarration,
    followingNarrationRef,
    followSpokenWord,
    readerNavigationRevision,
    currDocPage,
    currentSentence,
    currentSegment,
    renderedPagePart,
    highlightPattern,
    clearHighlights,
    clearWordHighlights,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    parsedDocument,
    resolvedLanguage,
    playbackPlanSegmentCount,
    layoutKey,
    surfaceKey,
    textLayerReadyLayoutKey,
    isPageRendering,
    commitSurfacePart,
    reportSurfaceCommitError,
  ]);

  // The timed word owns following when available, including with segment-only paint.
  useEffect(() => {
    clearWordHighlightTimeouts();

    if ((!pdfWordHighlightEnabled && !(pdfHighlightEnabled && followSpokenWord))
      || !renderedPagePart || !renderedPageWords || !hasSpokenWord) {
      clearWordHighlights();
      return;
    }

    if (isPageRendering || textLayerReadyLayoutKey !== layoutKey) {
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
        renderedPageWords.alignment,
        pageWordIndex,
        renderedPagePart.text,
        containerRef as RefObject<HTMLDivElement>,
        { follow: followingNarrationRef.current && followSpokenWord, paintWord: pdfWordHighlightEnabled },
      );

      if (isLayoutChange && pdfWordHighlightEnabled) {
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

    // A page turn paints the spoken word at once; the retry above covers a
    // sentence layer that has not mapped yet.
    if (isLayoutChange) clearWordHighlights();
    tryApplyWord(0);
    return cleanup;
  }, [
    pageWordIndex,
    hasSpokenWord,
    followSpokenWord,
    followingNarrationRef,
    readerNavigationRevision,
    renderedPagePart,
    renderedPageWords,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    clearWordHighlights,
    highlightWordIndex,
    layoutKey,
    textLayerReadyLayoutKey,
    clearWordHighlightTimeouts,
    scheduleWordTimeout,
    isPageRendering
  ]);

  // Page slots are sized before React-PDF paints. Place a commanded page
  // once so subsequent text-layer updates don't overwrite narration scroll.
  useLayoutEffect(() => {
    commandedScrollTopRef.current = null;
    if (viewType !== 'scroll') return;
    if (scrollSyncedPageRef.current === currDocPage) {
      scrollSyncedPageRef.current = null;
      return;
    }

    const container = containerRef.current;
    const page = scrollPageRefs.current.get(currDocPage);
    if (!container || !page) return;

    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }

    const previousTop = container.scrollTop;
    container.scrollTo({
      top: previousTop + page.getBoundingClientRect().top - container.getBoundingClientRect().top,
      behavior: 'instant',
    });
    if (container.scrollTop !== previousTop) commandedScrollTopRef.current = container.scrollTop;
  }, [currDocPage, currDocPages, viewType]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  const handleScroll = useCallback(() => {
    const commandedTop = commandedScrollTopRef.current;
    commandedScrollTopRef.current = null;
    // A short final page can be less visible than its neighbor after a page
    // command because the container clamps the scroll at the document end.
    if (commandedTop === containerRef.current?.scrollTop) return;
    if (viewType !== 'scroll' || followingNarrationRef.current || scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = containerRef.current;
      if (!container || followingNarrationRef.current) return;

      const containerRect = container.getBoundingClientRect();
      let visiblePage = currDocPage;
      let visibleHeight = -1;
      for (const [pageNumber, page] of scrollPageRefs.current) {
        const pageRect = page.getBoundingClientRect();
        const overlap = Math.max(
          0,
          Math.min(containerRect.bottom, pageRect.bottom)
            - Math.max(containerRect.top, pageRect.top),
        );
        if (overlap > visibleHeight) {
          visibleHeight = overlap;
          visiblePage = pageNumber;
        }
      }

      if (visiblePage === currDocPage) return;
      scrollSyncedPageRef.current = visiblePage;
      browseToLocation(visiblePage);
    });
  }, [currDocPage, browseToLocation, followingNarrationRef, viewType]);

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
              className="absolute border border-accent-line rounded-sm"
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
      onScroll={handleScroll}
      onWheel={() => setFollowingNarration(false)}
      onTouchMove={() => setFollowingNarration(false)}
      className="flex flex-col items-center-safe overflow-auto w-full px-6 h-full pdf-viewer"
    >
      <Document
        key={currDocId || 'pdf'}
        loading={null}
        noData={null}
        file={documentFile}
        onLoadError={reportSurfaceCommitError}
        onSourceError={reportSurfaceCommitError}
        onLoadSuccess={(pdf) => {
          onDocumentLoadSuccess(pdf);
        }}
        onItemClick={(args: PDFOnLinkClickArgs) => {
          if (args?.pageNumber) {
            browseToLocation(args.pageNumber);
          } else if (args?.dest) {
            const destArray = args.dest as Array<number> || [];
            const pageNum = destArray[0] + 1 || null;
            if (pageNum) {
              browseToLocation(pageNum);
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
                <div
                  key={`page_wrap_${i + 1}`}
                  ref={(node) => {
                    if (node) scrollPageRefs.current.set(i + 1, node);
                    else scrollPageRefs.current.delete(i + 1);
                  }}
                  role="region"
                  aria-label={`PDF page ${i + 1}`}
                  className="relative"
                  style={pageSlotSize(i + 1)}
                >
                  <Page
                    key={`page_${i + 1}`}
                    pageNumber={i + 1}
                    renderAnnotationLayer={true}
                    renderTextLayer={i + 1 === currDocPage}
                    className="shadow-elev-2"
                    scale={renderScale}
                    onRenderSuccess={i + 1 === currDocPage ? handlePageRenderSuccess : undefined}
                    onRenderError={reportSurfaceCommitError}
                    onRenderTextLayerSuccess={i + 1 === currDocPage ? handleTextLayerRenderSuccess : undefined}
                    onRenderTextLayerError={reportSurfaceCommitError}
                    onLoadSuccess={handlePageLoadSuccess}
                  />
                  {renderParsedOverlay(i + 1)}
                </div>
              ))}
            </div>
          ) : (
            // Single/Dual page mode
            <div key={viewType} className="flex justify-center gap-4">
              {currDocPages && leftPage > 0 && (
                <div role="region" aria-label={`PDF page ${leftPage}`} className="relative" style={pageSlotSize(leftPage)}>
                  <Page
                    key={`page_${leftPage}`}
                    pageNumber={leftPage}
                    renderAnnotationLayer={true}
                    renderTextLayer={leftPage === currDocPage}
                    className="shadow-elev-2"
                    scale={renderScale}
                    onRenderSuccess={leftPage === currDocPage ? handlePageRenderSuccess : undefined}
                    onRenderError={reportSurfaceCommitError}
                    onRenderTextLayerSuccess={leftPage === currDocPage ? handleTextLayerRenderSuccess : undefined}
                    onRenderTextLayerError={reportSurfaceCommitError}
                    onLoadSuccess={handlePageLoadSuccess}
                  />
                  {renderParsedOverlay(leftPage)}
                </div>
              )}
              {currDocPages && rightPage && rightPage <= currDocPages && viewType === 'dual' && (
                <div role="region" aria-label={`PDF page ${rightPage}`} className="relative" style={pageSlotSize(rightPage)}>
                  <Page
                    key={`page_${rightPage}`}
                    pageNumber={rightPage}
                    renderAnnotationLayer={true}
                    renderTextLayer={rightPage === currDocPage}
                    className="shadow-elev-2"
                    scale={renderScale}
                    onRenderSuccess={rightPage === currDocPage ? handlePageRenderSuccess : undefined}
                    onRenderError={reportSurfaceCommitError}
                    onRenderTextLayerSuccess={rightPage === currDocPage ? handleTextLayerRenderSuccess : undefined}
                    onRenderTextLayerError={reportSurfaceCommitError}
                    onLoadSuccess={handlePageLoadSuccess}
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
