'use client';

import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTTS } from '@/contexts/TTSContext';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { SegmentsSidebar } from '@/components/reader/SegmentsSidebar';
import { Header } from '@/components/Header';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { resolveDocumentId } from '@/lib/client/dexie';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { LoadingSpinner } from '@/components/Spinner';
import { PdfLayoutScan } from '@/components/reader/PdfLayoutScan';
import { Button, ButtonLink } from '@/components/ui';
import {
  FORCE_REPARSE_CONFIRM_MESSAGE,
  FORCE_REPARSE_CONFIRM_TEXT,
  FORCE_REPARSE_CONFIRM_TITLE,
  isForceReparseDisabled,
} from '@/lib/client/pdf/force-reparse';
import { useUnmountCleanupRef } from '@/hooks/useUnmountCleanupRef';
import { usePdfDocument } from './usePdfDocument';

// Dynamic import for client-side rendering only
const PDFViewer = dynamic(
  () => import('@/components/views/PDFViewer').then((module) => module.PDFViewer),
  {
    ssr: false,
    loading: () => null
  }
);

const PARSE_LOADER_EXPAND_DELAY_MS = 320;

export default function PDFViewerPage() {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const { id } = useParams();
  const router = useRouter();
  const pdfState = usePdfDocument();
  const {
    setCurrentDocument,
    currDocName,
    clearCurrDoc,
    currDocPage,
    currDocPages,
    isPlaybackReady,
    parseStatus,
    parseProgress,
    documentSettings,
    updateDocumentSettings,
    parsedOverlayEnabled,
    setParsedOverlayEnabled,
    forceReparseParsedPdf,
    createFullAudioBook: createPDFAudioBook,
    regenerateChapter: regeneratePDFChapter,
  } = pdfState;
  const { stop } = useTTS();
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPdfViewerReady, setIsPdfViewerReady] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook' | 'segments'>(null);
  const [showForceReparseConfirm, setShowForceReparseConfirm] = useState(false);
  const [showDetailedParseLoader, setShowDetailedParseLoader] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);
  const [isNavigatingBack, setIsNavigatingBack] = useState(false);
  const parseUiState: NonNullable<typeof parseStatus> = parseStatus ?? 'pending';
  const hasResolvedParseStatus = parseStatus !== null;
  const isParseReady = parseUiState === 'ready';
  const forceReparseDisabled = isForceReparseDisabled(parseStatus);
  const hasRealParseProgress = !!parseProgress
    && parseProgress.totalPages > 0
    && parseProgress.pagesParsed >= 0;
  const shouldShowExpandedParseLoader = !isLoading
    && hasResolvedParseStatus
    && (parseUiState === 'pending' || parseUiState === 'running' || parseUiState === 'failed' || hasRealParseProgress);

  useEffect(() => {
    setIsLoading(true);
    setIsPdfViewerReady(false);
    setError(null);
    setActiveSidebar(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [id]);

  const loadDocument = useCallback(async () => {
    if (!isLoading) return; // Prevent calls when not loading new doc
    console.log('Loading new document (from page.tsx)');
    let didRedirect = false;
    let startedLoad = false;
    let loadSucceeded = false;
    try {
      if (!id) {
        setError('Document not found');
        return;
      }
      const resolved = await resolveDocumentId(id as string);
      if (resolved !== (id as string)) {
        didRedirect = true;
        router.replace(`/pdf/${resolved}`);
        return;
      }

      if (loadedDocIdRef.current === resolved) {
        return;
      }
      if (inFlightDocIdRef.current === resolved) {
        return;
      }

      startedLoad = true;
      inFlightDocIdRef.current = resolved;
      stop(); // Reset TTS when loading new document
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const loaded = await setCurrentDocument(resolved);
        if (loaded) {
          loadSucceeded = true;
          loadedDocIdRef.current = resolved;
          break;
        }
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!loadSucceeded) {
        throw new Error(`Failed to load PDF document ${resolved}`);
      }
    } catch (err) {
      console.error('Error loading document:', err);
      setError('Failed to load document');
    } finally {
      if (startedLoad) {
        inFlightDocIdRef.current = null;
      }
      if (!didRedirect && startedLoad && loadSucceeded) {
        setIsLoading(false);
      }
    }
  }, [isLoading, id, router, setCurrentDocument, stop]);

  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

  useUnmountCleanupRef(clearCurrDoc);

  useEffect(() => {
    if (isLoading) return;
    if (isParseReady) return;
    stop();
  }, [isLoading, isParseReady, stop]);

  useEffect(() => {
    if (!shouldShowExpandedParseLoader) {
      // Keep the current loader variant stable during the final
      // parse-ready -> first-frame handoff to avoid a visual flash.
      if (!isLoading && isParseReady && !isPdfViewerReady) {
        return;
      }
      setShowDetailedParseLoader(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setShowDetailedParseLoader(true);
    }, PARSE_LOADER_EXPAND_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [shouldShowExpandedParseLoader, id, isLoading, isParseReady, isPdfViewerReady]);

  // Compute available height = viewport - (header height + tts bar height)
  useEffect(() => {
    const compute = () => {
      const header = document.querySelector('[data-app-header]') as HTMLElement | null;
      const ttsbar = document.querySelector('[data-app-ttsbar]') as HTMLElement | null;
      const headerH = header ? header.getBoundingClientRect().height : 0;
      const ttsH = ttsbar ? ttsbar.getBoundingClientRect().height : 0;
      const vh = window.innerHeight;
      const h = Math.max(0, vh - headerH - ttsH);
      // Avoid locking the reader at 0px during transient startup layout states.
      if (h > 0) {
        setContainerHeight(`${h}px`);
      }
    };
    compute();
    const settleT1 = window.setTimeout(compute, 0);
    const settleT2 = window.setTimeout(compute, 120);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('resize', compute);
      window.clearTimeout(settleT1);
      window.clearTimeout(settleT2);
    };
  }, [isLoading, isParseReady, isAtLimit, activeSidebar]);

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 10, 300));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 10, 50));

  const handleBackToDocuments = useCallback((event?: MouseEvent) => {
    event?.preventDefault();
    if (isNavigatingBack) return;
    setIsNavigatingBack(true);
    stop();
    setActiveSidebar(null);
    router.push('/app');
  }, [isNavigatingBack, stop, router]);

  const requestForceReparse = useCallback(() => {
    if (forceReparseDisabled) return;
    setShowForceReparseConfirm(true);
  }, [forceReparseDisabled]);

  const confirmForceReparse = useCallback(() => {
    setShowForceReparseConfirm(false);
    void forceReparseParsedPdf();
  }, [forceReparseParsedPdf]);

  const handleGenerateAudiobook = useCallback(async (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings
  ) => {
    if (!isParseReady) {
      throw new Error('PDF parsing is not ready yet.');
    }
    return createPDFAudioBook(onProgress, signal, onChapterComplete, id as string, settings.format, settings);
  }, [createPDFAudioBook, id, isParseReady]);

  const handleRegenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    settings: AudiobookGenerationSettings,
    signal: AbortSignal
  ) => {
    if (!isParseReady) {
      throw new Error('PDF parsing is not ready yet.');
    }
    return regeneratePDFChapter(chapterIndex, bookId, settings.format, signal, settings);
  }, [regeneratePDFChapter, isParseReady]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-danger mb-4">{error}</p>
        <ButtonLink href="/app" onClick={handleBackToDocuments} variant="secondary" size="md" className="gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Documents
        </ButtonLink>
      </div>
    );
  }

  const renderPdfStatusLoader = () => {
    const compactLabel = isLoading
      ? 'Opening PDF...'
      : (parseUiState === 'ready' ? 'Rendering pages...' : 'Preparing PDF layout...');
    const compactSubLabel = isLoading
      ? 'Loading document data'
      : (parseUiState === 'ready' ? 'Preparing first frame' : 'Queueing parser and preparing page extraction');

    const totalPages = parseProgress?.totalPages ?? 0;
    const pagesParsed = parseProgress?.pagesParsed ?? 0;
    const progressPercent = totalPages > 0
      ? Math.max(0, Math.min(100, (pagesParsed / totalPages) * 100))
      : 0;
    const hasMeasuredProgress = totalPages > 0;
    const isMerging = parseProgress?.phase === 'merge';

    let statusText = 'Loading PDF...';
    if (!isLoading) {
      if (parseUiState === 'pending') {
        statusText = 'Preparing PDF layout...';
      } else if (parseUiState === 'running') {
        statusText = 'Parsing PDF layout blocks...';
      } else if (parseUiState === 'failed') {
        statusText = 'PDF parsing failed. Retry to continue.';
      }
    }

    const stageLabel = parseUiState === 'failed'
      ? 'Stage: blocked'
      : (parseUiState === 'pending'
        ? 'Stage: prepare'
        : (isMerging ? 'Stage: merge' : 'Stage: infer'));

    return (
      <div className="h-full w-full bg-surface">
        <div className={`mx-auto flex h-full items-center px-4 py-6 transition duration-slow ease-standard max-w-sm`}>
          {showDetailedParseLoader ? (
            <div className="relative w-full overflow-hidden rounded-lg border border-line bg-surface-sunken shadow-elev-2">
              {/* prism top edge + corner glow for depth */}
              <div className="prism-divider" />
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full blur-3xl"
                style={{ background: 'var(--accent-wash)' }}
              />
              {/* dotted texture spanning the whole loader */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    'radial-gradient(color-mix(in srgb, var(--foreground) 14%, transparent) 1px, transparent 1px)',
                  backgroundSize: '12px 12px',
                  opacity: 0.35,
                  WebkitMaskImage: 'radial-gradient(120% 100% at 50% 40%, #000 55%, transparent 100%)',
                  maskImage: 'radial-gradient(120% 100% at 50% 40%, #000 55%, transparent 100%)',
                }}
              />

              <div className="relative p-3.5 sm:p-4">
                {/* header: status badge + model attribution */}
                <div className="flex items-start justify-between gap-3">
                  <div className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-solid px-2.5 py-1">
                    {parseUiState === 'failed' ? (
                      <svg className="h-3.5 w-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z" />
                      </svg>
                    ) : (
                      <LoadingSpinner className="h-3.5 w-3.5 text-accent" />
                    )}
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-soft">PDF Layout Parse</span>
                  </div>
                  <div className="inline-flex items-center gap-1.5 rounded-md border border-accent-line bg-accent-wash px-2 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    <span className="text-[10px] font-semibold tracking-tight text-accent-strong">PP-DocLayout-V3</span>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-3">
                  {/* animated layout scanner — static "halted" view when failed */}
                  <div className="mx-auto w-full max-w-[15rem]">
                    <PdfLayoutScan failed={parseUiState === 'failed'} />
                  </div>

                  {/* live status + progress */}
                  {parseUiState === 'failed' ? (
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{statusText}</p>
                      <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-soft">{stageLabel}</p>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <div className="flex items-end justify-between gap-2">
                        <p className="text-[11px] font-semibold text-foreground tabular-nums">
                          {hasMeasuredProgress ? `Page ${pagesParsed} / ${totalPages}` : 'Awaiting first page'}
                        </p>
                        <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-soft">{stageLabel}</p>
                      </div>
                      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-solid ring-1 ring-line">
                        <div
                          className="progress-fill h-full rounded-full bg-accent transition-[width] duration-slow ease-standard"
                          style={{ width: `${hasMeasuredProgress ? progressPercent : 6}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-[10px] tabular-nums text-soft">
                        {hasMeasuredProgress ? `${Math.round(progressPercent)}% complete` : 'Calibrating layout pass'}
                      </p>
                    </div>
                  )}
                </div>

                {/* attribution footer */}
                <div className="mt-3 flex items-center gap-2 border-t border-line-soft pt-3">
                  <svg className="h-3.5 w-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m-6-8h6M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
                  </svg>
                  <p className="text-[10px] leading-snug text-faint">
                    Classifying footnotes, titles, tables, figures, formulas, &amp; more with <span className="font-semibold text-soft">PP-DocLayout-V3</span>.
                  </p>
                </div>

                {!isLoading && parseUiState === 'failed' ? (
                  <div className="mt-3 flex justify-start">
                    <Button
                      type="button"
                      onClick={requestForceReparse}
                      variant="secondary"
                      size="sm"
                    >
                      Retry Parse
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="w-full rounded-lg border border-line bg-surface-sunken p-4 shadow-elev-1 transition duration-slow ease-standard overflow-hidden">
              <div className="h-0.5 -mx-4 -mt-4 mb-3 bg-[linear-gradient(90deg,var(--accent),transparent_75%)]" />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{compactLabel}</p>
                  <p className="mt-1 text-xs text-soft">{compactSubLabel}</p>
                </div>
                <span className="inline-flex items-center justify-center rounded-md border border-line bg-surface p-1.5">
                  <LoadingSpinner className="h-3.5 w-3.5 text-accent" />
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                <span className="h-1.5 rounded-full bg-accent-wash animate-pulse" />
                <span className="h-1.5 rounded-full bg-accent-wash animate-pulse [animation-delay:120ms]" />
                <span className="h-1.5 rounded-full bg-accent-wash animate-pulse [animation-delay:220ms]" />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <Header
        left={
          <ButtonLink href="/app" onClick={handleBackToDocuments} variant="secondary" size="sm" className="gap-2" aria-label="Back to documents">
            <svg className="w-3 h-3" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Documents
          </ButtonLink>
        }
        title={isLoading ? 'Loading…' : (currDocName || '')}
        right={
          <div className="flex items-center gap-2">
            <DocumentHeaderMenu
              zoomLevel={zoomLevel}
              onZoomIncrease={handleZoomIn}
              onZoomDecrease={handleZoomOut}
              onOpenSettings={() => setActiveSidebar((prev) => prev === 'settings' ? null : 'settings')}
              onOpenAudiobook={() => setActiveSidebar((prev) => prev === 'audiobook' ? null : 'audiobook')}
              onOpenSegments={() => setActiveSidebar((prev) => prev === 'segments' ? null : 'segments')}
              isSettingsOpen={activeSidebar === 'settings'}
              isAudiobookOpen={activeSidebar === 'audiobook'}
              isSegmentsOpen={activeSidebar === 'segments'}
              showAudiobookExport={canExportAudiobook}
              minZoom={50}
              maxZoom={300}
            />
          </div>
        }
      />
      <div className="relative overflow-hidden" style={{ height: containerHeight }}>
        {isParseReady ? (
          <div className={isPdfViewerReady ? 'h-full' : 'h-full opacity-0 pointer-events-none'}>
            <PDFViewer
              zoomLevel={zoomLevel}
              onDocumentReady={() => setIsPdfViewerReady(true)}
              pdfState={pdfState}
            />
          </div>
        ) : null}
        {isLoading || !isParseReady || !isPdfViewerReady ? (
          <div className="absolute inset-0 z-10" data-testid="pdf-status-loader">
            {renderPdfStatusLoader()}
          </div>
        ) : null}
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="pdf"
          documentId={id as string}
          onGenerateAudiobook={handleGenerateAudiobook}
          onRegenerateChapter={handleRegenerateChapter}
        />
      )}
      {isAtLimit ? (
        <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface" data-app-ttsbar>
          <div className="px-2 md:px-3 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-1 min-h-10">
            <RateLimitPauseButton />
            <RateLimitBanner />
          </div>
        </div>
      ) : isParseReady ? (
        <TTSPlayer currentPage={currDocPage} numPages={currDocPages} isPlaybackReady={isPlaybackReady} />
      ) : null}
      <DocumentSettings
        isOpen={activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        language={documentSettings.language ?? 'auto'}
        onLanguageChange={(language) => {
          void updateDocumentSettings({
            ...documentSettings,
            schemaVersion: 1,
            language,
          });
        }}
        pdf={{
          parseStatus,
          parsedOverlayEnabled,
          skipBlockKinds: documentSettings.pdf?.skipBlockKinds ?? [],
          onToggleOverlay: (enabled) => setParsedOverlayEnabled(enabled),
          onToggleSkipKind: (kind, enabled) => {
            const current = new Set(documentSettings.pdf?.skipBlockKinds ?? []);
            if (enabled) current.add(kind);
            else current.delete(kind);
            void updateDocumentSettings({
              ...documentSettings,
              schemaVersion: 1,
              pdf: {
                ...(documentSettings.pdf ?? {}),
                skipBlockKinds: Array.from(current),
              },
            });
          },
          onForceReparse: requestForceReparse,
        }}
      />
      <ConfirmDialog
        isOpen={showForceReparseConfirm}
        onClose={() => setShowForceReparseConfirm(false)}
        onConfirm={confirmForceReparse}
        title={FORCE_REPARSE_CONFIRM_TITLE}
        message={FORCE_REPARSE_CONFIRM_MESSAGE}
        confirmText={FORCE_REPARSE_CONFIRM_TEXT}
        cancelText="Cancel"
      />
      <SegmentsSidebar
        isOpen={activeSidebar === 'segments'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'segments' : (prev === 'segments' ? null : prev))}
        documentId={id as string}
      />
    </>
  );
}
