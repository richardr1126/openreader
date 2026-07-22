'use client';

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from 'react';
import { HTMLViewer } from '@/components/views/HTMLViewer';
import { ReaderPhaseLoader } from '@/components/reader/ReaderPhaseLoader';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useLatestRef } from '@/hooks/useLatestRef';
import { useUnmountCleanupRef } from '@/hooks/useUnmountCleanupRef';
import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';
import { ButtonLink } from '@/components/ui';
import { serializeReaderPosition } from '@/lib/client/reader-progress';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { deriveReaderLoadState } from '@/lib/client/reader-load';
import { useHtmlDocument } from './useHtmlDocument';

export default function HTMLPage() {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const { id } = useParams();
  const routeDocumentId = typeof id === 'string' ? id : undefined;
  const bootstrap = useReaderBootstrap(routeDocumentId, 'html');
  const {
    disableProgressPersistence,
    enableProgressPersistence,
    scheduleProgress,
  } = bootstrap;
  const htmlState = useHtmlDocument();
  const {
    setCurrentDocument,
    currDocData,
    currDocName,
    isPlaybackReady,
    blocks,
    isTxt,
    clearCurrDoc,
  } = htmlState;
  const {
    currDocPage,
    currentSentenceOrdinal,
    prepareInitialPosition,
    sentences,
    stop,
    documentLanguage,
    setDocumentLanguage,
    invalidatePlaybackPlan,
    playbackPlanLifecycle,
    preparePlaybackPlan,
    retryPlaybackPlan,
  } = useTTS();
  const disableProgressPersistenceRef = useLatestRef(disableProgressPersistence);
  const stopRef = useLatestRef(stop);
  const documentSettings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, bootstrap.settings);
  const language = documentSettings.language ?? 'auto';
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<Error | null>(null);
  const [viewerRevision, setViewerRevision] = useState(0);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(50); // 0..100 (50 = 50% default width)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);

  useEffect(() => {
    disableProgressPersistenceRef.current();
    stopRef.current();
    setIsLoading(true);
    setViewerReady(false);
    setViewerError(null);
    setError(null);
    setActiveSidebar(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [disableProgressPersistenceRef, routeDocumentId, stopRef]);

  useEffect(() => {
    if (bootstrap.phase !== 'error') return;
    setError(bootstrap.error ?? new Error('Failed to load document'));
    setIsLoading(false);
  }, [bootstrap.error, bootstrap.phase]);

  const loadDocument = useCallback(async () => {
    if (!isLoading) return;
    console.log('Loading new HTML document (from page.tsx)');
    let startedLoad = false;
    let loadSucceeded = false;
    try {
      if (bootstrap.phase !== 'ready' || !bootstrap.document) return;
      const resolved = bootstrap.document.id;

      if (loadedDocIdRef.current === resolved) {
        return;
      }
      if (inFlightDocIdRef.current === resolved) {
        return;
      }

      startedLoad = true;
      inFlightDocIdRef.current = resolved;
      if (bootstrap.initialPosition?.readerType === 'html') {
        prepareInitialPosition(bootstrap.initialPosition.location, bootstrap.initialPosition.segmentOrdinal);
      }
      await setCurrentDocument(bootstrap.document);
      loadedDocIdRef.current = resolved;
      loadSucceeded = true;
    } catch (err) {
      console.error('Error loading document:', err);
      setError(err instanceof Error ? err : new Error('Failed to load document'));
    } finally {
      if (startedLoad) {
        inFlightDocIdRef.current = null;
      }
      if (startedLoad && loadSucceeded) {
        setIsLoading(false);
      }
    }
  }, [bootstrap.document, bootstrap.initialPosition, bootstrap.phase, isLoading, prepareInitialPosition, setCurrentDocument]);

  useEffect(() => {
    if (!isLoading) return;
    loadDocument();
  }, [loadDocument, isLoading]);

  const clearReaderSession = useCallback(() => {
    disableProgressPersistence();
    clearCurrDoc();
  }, [clearCurrDoc, disableProgressPersistence]);
  useUnmountCleanupRef(clearReaderSession);

  useEffect(() => {
    setDocumentLanguage(language);
  }, [language, setDocumentLanguage]);

  useEffect(() => {
    if (isLoading || currDocData === undefined || documentLanguage !== language || playbackPlanLifecycle.status !== 'idle') return;
    void preparePlaybackPlan();
  }, [currDocData, documentLanguage, isLoading, language, playbackPlanLifecycle.status, preparePlaybackPlan]);

  const loadState = deriveReaderLoadState({
    bootstrapPhase: bootstrap.phase,
    bootstrapError: bootstrap.error,
    sourceStatus: error ? 'failed' : (isLoading ? 'loading' : (currDocData !== undefined ? 'ready' : 'failed')),
    sourceError: error,
    plan: playbackPlanLifecycle,
    viewerReady,
    viewerError,
  });
  const readerReady = !loadState.blocking;

  useEffect(() => {
    if (!readerReady) return;
    enableProgressPersistence();
  }, [enableProgressPersistence, readerReady]);

  useEffect(() => {
    if (!routeDocumentId || !readerReady || !isPlaybackReady || sentences.length === 0) return;
    scheduleProgress({
      documentId: routeDocumentId,
      readerType: 'html',
      location: serializeReaderPosition('html', currDocPage, currentSentenceOrdinal ?? 0),
    });
  }, [
    currDocPage,
    currentSentenceOrdinal,
    readerReady,
    isPlaybackReady,
    routeDocumentId,
    scheduleProgress,
    sentences.length,
  ]);

  useEffect(() => {
    if (playbackPlanLifecycle.status === 'queued' || playbackPlanLifecycle.status === 'running') {
      setActiveSidebar(null);
    }
  }, [playbackPlanLifecycle.status]);

  const retryLoad = useCallback(() => {
    setError(null);
    if (loadState.retryKind === 'bootstrap') {
      setIsLoading(true);
      void bootstrap.retry();
      return;
    }
    if (loadState.retryKind === 'plan') {
      void retryPlaybackPlan();
      return;
    }
    if (loadState.retryKind === 'render') {
      setViewerError(null);
      setViewerReady(false);
      setViewerRevision((revision) => revision + 1);
      return;
    }
    loadedDocIdRef.current = null;
    inFlightDocIdRef.current = null;
    setIsLoading(true);
  }, [bootstrap, loadState.retryKind, retryPlaybackPlan]);

  // Compute available height = viewport - (header height + tts bar height)
  useEffect(() => {
    const compute = () => {
      const header = document.querySelector('[data-app-header]') as HTMLElement | null;
      const ttsbar = document.querySelector('[data-app-ttsbar]') as HTMLElement | null;
      const headerH = header ? header.getBoundingClientRect().height : 0;
      const ttsH = ttsbar ? ttsbar.getBoundingClientRect().height : 0;
      const vh = window.innerHeight;
      const h = Math.max(0, vh - headerH - ttsH);
      if (h > 0) {
        setContainerHeight(`${h}px`);
      }

      // Adaptive minimum content width: allow some padding on narrow screens
      const vw = window.innerWidth;
      const desiredMin = 640;
      const minContent = Math.min(desiredMin, Math.max(320, vw - 32));
      const maxPad = Math.max(0, Math.floor((vw - minContent) / 2));
      setMaxPadPx(maxPad);
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
  }, [readerReady, activeSidebar]);

  return (
    <>
      <Header
        left={
          <ButtonLink href="/app" variant="secondary" size="sm" className="gap-2" aria-label="Back to documents">
            <svg className="w-3 h-3" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Documents
          </ButtonLink>
        }
        title={currDocName || bootstrap.document?.name || 'Opening document'}
        right={readerReady ? (
          <div className="flex items-center gap-3">
            <DocumentHeaderMenu
              zoomLevel={padPct}
              onZoomIncrease={() => setPadPct(p => Math.min(p + 10, 100))}
              onZoomDecrease={() => setPadPct(p => Math.max(p - 10, 0))}
              onOpenSettings={() => setActiveSidebar((prev) => prev === 'settings' ? null : 'settings')}
              onOpenAudiobook={() => setActiveSidebar((prev) => prev === 'audiobook' ? null : 'audiobook')}
              isSettingsOpen={activeSidebar === 'settings'}
              isAudiobookOpen={activeSidebar === 'audiobook'}
              showAudiobookExport={canExportAudiobook}
              minZoom={0}
              maxZoom={100}
            />
          </div>
        ) : null}
      />
      <div className="relative overflow-hidden" style={{ height: containerHeight }}>
        {currDocData !== undefined ? (
          <div
            className={readerReady ? 'h-full w-full' : 'h-full w-full opacity-0 pointer-events-none'}
            aria-hidden={!readerReady}
            style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}
          >
            <HTMLViewer
              key={viewerRevision}
              className="h-full"
              blocks={blocks}
              isTxt={isTxt}
              onReady={() => setViewerReady(true)}
              onError={setViewerError}
            />
          </div>
        ) : null}
        {loadState.blocking ? (
          <div className="absolute inset-0 z-10">
            <ReaderPhaseLoader
              phase={loadState.phase as Exclude<typeof loadState.phase, 'ready'>}
              error={loadState.error}
              onRetry={loadState.retryKind ? retryLoad : undefined}
            />
          </div>
        ) : null}
      </div>
      {canExportAudiobook && readerReady && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="html"
          documentId={id as string}
        />
      )}
      {readerReady && (isAtLimit ? (
        <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface" data-app-ttsbar>
          <div className="px-2 md:px-3 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-1 min-h-10">
            <RateLimitPauseButton />
            <RateLimitBanner />
          </div>
        </div>
      ) : (
        <TTSPlayer isPlaybackReady={isPlaybackReady} hasReadableContent={sentences.length > 0} />
      ))}
      <DocumentSettings
        html
        isOpen={readerReady && activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={id as string}
        language={language}
        onLanguageChange={(nextLanguage) => {
          void bootstrap.updateSettings({
            ...documentSettings,
            schemaVersion: 1,
            language: nextLanguage,
          }).then(() => invalidatePlaybackPlan());
        }}
      />
    </>
  );
}
