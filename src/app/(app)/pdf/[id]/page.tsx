'use client';

import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTTS } from '@/contexts/TTSContext';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { Header } from '@/components/Header';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { ReaderError, ReaderLoader } from '@/components/reader/ReaderLoader';
import { ButtonLink } from '@/components/ui';
import {
  FORCE_REPARSE_CONFIRM_MESSAGE,
  FORCE_REPARSE_CONFIRM_TEXT,
  FORCE_REPARSE_CONFIRM_TITLE,
  isForceReparseDisabled,
} from '@/lib/client/pdf/force-reparse';
import { useLatestRef } from '@/hooks/useLatestRef';
import { useUnmountCleanupRef } from '@/hooks/useUnmountCleanupRef';
import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';
import { serializeReaderPosition } from '@/lib/shared/reader-position';
import type { DocumentSettings as DocumentSettingsValue } from '@/types/document-settings';
import { usePdfDocument } from './usePdfDocument';

// Dynamic import for client-side rendering only
const PDFViewer = dynamic(
  () => import('@/components/views/PDFViewer').then((module) => module.PDFViewer),
  {
    ssr: false,
    loading: () => null
  }
);

export default function PDFViewerPage() {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const { id } = useParams();
  const routeDocumentId = typeof id === 'string' ? id : undefined;
  const router = useRouter();
  const bootstrap = useReaderBootstrap(routeDocumentId);
  const { result } = bootstrap;
  const {
    disableProgressPersistence,
    enableProgressPersistence,
    scheduleProgress,
  } = bootstrap;
  const pdfState = usePdfDocument(
    result.status === 'ready' && result.payload.readerType === 'pdf' ? routeDocumentId : undefined,
    result.status === 'ready' ? result.payload.settings : null,
    bootstrap.updateSettings,
  );
  const {
    setCurrentDocument,
    currDocName,
    clearCurrDoc,
    currDocPage,
    currDocPages,
    isPlaybackReady,
    parseStatus,
    documentSettings,
    updateDocumentSettings,
    parsedOverlayEnabled,
    setParsedOverlayEnabled,
    forceReparseParsedPdf,
  } = pdfState;
  const {
    currentSentenceOrdinal,
    pause,
    prepareInitialPosition,
    sentences,
    stop,
    invalidatePlaybackPlan,
    setPdfSkipBlockKinds,
    acceptBootstrapPlaybackPlan,
    documentLanguage,
  } = useTTS();
  const disableProgressPersistenceRef = useLatestRef(disableProgressPersistence);
  const stopRef = useLatestRef(stop);
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPdfViewerReady, setIsPdfViewerReady] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook'>(null);
  const [showForceReparseConfirm, setShowForceReparseConfirm] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);
  const [isNavigatingBack, setIsNavigatingBack] = useState(false);
  const isParseReady = parseStatus === 'ready';
  const forceReparseDisabled = isForceReparseDisabled(parseStatus);

  useEffect(() => {
    setPdfSkipBlockKinds(documentSettings.pdf?.skipBlockKinds ?? []);
    return () => setPdfSkipBlockKinds(null);
  }, [documentSettings.pdf?.skipBlockKinds, setPdfSkipBlockKinds]);

  useEffect(() => {
    disableProgressPersistenceRef.current();
    stopRef.current();
    setIsLoading(true);
    setIsPdfViewerReady(false);
    setError(null);
    setActiveSidebar(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [disableProgressPersistenceRef, routeDocumentId, stopRef]);

  useEffect(() => {
    if (result.status !== 'error') return;
    setError(result.message);
    setIsLoading(false);
  }, [result]);

  const loadDocument = useCallback(async () => {
    if (!isLoading) return; // Prevent calls when not loading new doc
    if (
      result.status === 'ready'
      && documentLanguage !== (result.payload.settings.language ?? 'auto')
    ) return;
    console.log('Loading new document (from page.tsx)');
    let startedLoad = false;
    let loadSucceeded = false;
    try {
      if (result.status !== 'ready') return;
      if (result.payload.readerType !== 'pdf') {
        throw new Error(`Expected a PDF document, received ${result.payload.readerType}`);
      }
      const resolved = result.payload.document.id;

      if (loadedDocIdRef.current === resolved) {
        return;
      }
      if (inFlightDocIdRef.current === resolved) {
        return;
      }

      startedLoad = true;
      inFlightDocIdRef.current = resolved;
      if (result.payload.initialPosition?.readerType === 'pdf') {
        prepareInitialPosition(result.payload.initialPosition.location);
      }
      await acceptBootstrapPlaybackPlan(result.payload.plan);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const loadResult = await setCurrentDocument(result.payload.document);
        if (loadResult === 'loaded') {
          loadSucceeded = true;
          loadedDocIdRef.current = resolved;
          break;
        }
        if (loadResult === 'superseded') {
          // A newer load (or unmount) is now authoritative; it owns the loading
          // lifecycle. Bail without surfacing an error to avoid the spurious
          // "Failed to load" screen on first launch.
          return;
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
      if (startedLoad && loadSucceeded) {
        enableProgressPersistence();
        setIsLoading(false);
      }
    }
  }, [acceptBootstrapPlaybackPlan, documentLanguage, enableProgressPersistence, isLoading, prepareInitialPosition, result, setCurrentDocument]);

  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

  const clearReaderSession = useCallback(() => {
    disableProgressPersistence();
    clearCurrDoc();
  }, [clearCurrDoc, disableProgressPersistence]);
  useUnmountCleanupRef(clearReaderSession);

  useEffect(() => {
    if (!routeDocumentId || isLoading || !isPlaybackReady || sentences.length === 0) return;
    scheduleProgress({
      documentId: routeDocumentId,
      readerType: 'pdf',
      location: serializeReaderPosition('pdf', currDocPage, currentSentenceOrdinal ?? 0),
    });
  }, [
    currDocPage,
    currentSentenceOrdinal,
    isLoading,
    isPlaybackReady,
    routeDocumentId,
    scheduleProgress,
    sentences.length,
  ]);

  useEffect(() => {
    if (isLoading) return;
    if (isParseReady) return;
    pause();
  }, [isLoading, isParseReady, pause]);

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
    disableProgressPersistence();
    stop();
    setActiveSidebar(null);
    router.push('/app');
  }, [disableProgressPersistence, isNavigatingBack, stop, router]);

  const requestForceReparse = useCallback(() => {
    if (forceReparseDisabled) return;
    setShowForceReparseConfirm(true);
  }, [forceReparseDisabled]);

  const confirmForceReparse = useCallback(() => {
    setShowForceReparseConfirm(false);
    void forceReparseParsedPdf();
  }, [forceReparseParsedPdf]);

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
              isSettingsOpen={activeSidebar === 'settings'}
              isAudiobookOpen={activeSidebar === 'audiobook'}
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
            {parseStatus === 'failed' ? (
              <ReaderError
                error={new Error('PDF parsing failed. Retry to continue.')}
                onRetry={requestForceReparse}
              />
            ) : (
              <ReaderLoader progress={result.status === 'pending' ? result.progress : undefined} />
            )}
          </div>
        ) : null}
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="pdf"
          documentId={id as string}
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
        documentId={id as string}
        language={documentSettings.language ?? 'auto'}
        onLanguageChange={(language) => {
          const nextSettings: DocumentSettingsValue = {
            ...documentSettings,
            schemaVersion: 1,
            language,
          };
          void updateDocumentSettings(nextSettings).then(() => {
            // Language changes how the worker segments text. The worker route
            // reads this from persisted document settings, so re-plan only after
            // the PUT has finished; otherwise the plan prefetch can recache the
            // old/default settings.
            invalidatePlaybackPlan();
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
            const nextSettings: DocumentSettingsValue = {
              ...documentSettings,
              schemaVersion: 1,
              pdf: {
                ...(documentSettings.pdf ?? {}),
                skipBlockKinds: Array.from(current),
              },
            };
            void updateDocumentSettings(nextSettings).then(() => {
              // skipBlockKinds feeds the worker-side plan signature. The server
              // reads it from the document-settings row, so wait for persistence
              // before dropping the cached plan and triggering prefetch.
              invalidatePlaybackPlan();
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
    </>
  );
}
