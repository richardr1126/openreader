'use client';

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from 'react';
import { EPUBViewer } from '@/components/views/EPUBViewer';
import { ReaderPhaseLoader } from '@/components/reader/ReaderPhaseLoader';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useLatestRef } from '@/hooks/useLatestRef';
import { useUnmountCleanupRef } from '@/hooks/useUnmountCleanupRef';
import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';
import { ButtonLink } from '@/components/ui';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { deriveReaderLoadState } from '@/lib/client/reader-load';
import { useEpubDocument } from './useEpubDocument';

export default function EPUBPage() {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const { id } = useParams();
  const routeDocumentId = typeof id === 'string' ? id : undefined;
  const bootstrap = useReaderBootstrap(routeDocumentId, 'epub');
  const {
    disableProgressPersistence,
    enableProgressPersistence,
    scheduleProgress,
  } = bootstrap;
  const epubState = useEpubDocument(routeDocumentId, scheduleProgress);
  const {
    setCurrentDocument,
    currDocName,
    isPlaybackReady,
    placementLifecycle,
    retryPlacement,
    failPlacement,
    clearCurrDoc,
    metadataLanguage,
    isMetadataReady,
  } = epubState;
  const {
    stop,
    documentLanguage,
    setDocumentLanguage,
    sentences,
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
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(100); // 0..100 (100 = full width, 0 = max padding)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);
  const didInitPadPctRef = useRef(false);

  useEffect(() => {
    disableProgressPersistenceRef.current();
    stopRef.current();
    setIsLoading(true);
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
    console.log('Loading new epub (from page.tsx)');
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
      const initialLocator = bootstrap.initialPosition?.readerType === 'epub'
        ? bootstrap.initialPosition.locator
        : null;
      await setCurrentDocument(bootstrap.document, initialLocator);
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
  }, [bootstrap.document, bootstrap.initialPosition, bootstrap.phase, setCurrentDocument]);

  useEffect(() => {
    if (!isLoading) return;

    loadDocument();
  }, [loadDocument, isLoading]);

  const clearReaderSession = useCallback(() => {
    disableProgressPersistence();
    clearCurrDoc();
  }, [clearCurrDoc, disableProgressPersistence]);
  useUnmountCleanupRef(clearReaderSession);

  const effectiveLanguage = language === 'auto' ? metadataLanguage ?? 'auto' : language;
  useEffect(() => {
    setDocumentLanguage(effectiveLanguage);
  }, [effectiveLanguage, setDocumentLanguage]);

  useEffect(() => {
    if (
      isLoading
      || !isMetadataReady
      || documentLanguage !== effectiveLanguage
      || playbackPlanLifecycle.status !== 'idle'
    ) return;
    void preparePlaybackPlan();
  }, [
    documentLanguage,
    effectiveLanguage,
    isLoading,
    isMetadataReady,
    playbackPlanLifecycle.status,
    preparePlaybackPlan,
  ]);

  const loadState = deriveReaderLoadState({
    bootstrapPhase: bootstrap.phase,
    bootstrapError: bootstrap.error,
    sourceStatus: error ? 'failed' : (isLoading ? 'loading' : (epubState.currDocData ? 'ready' : 'failed')),
    sourceError: error,
    parseStatus: isMetadataReady ? 'ready' : 'pending',
    plan: playbackPlanLifecycle,
    viewerReady: isPlaybackReady,
    viewerError: placementLifecycle.error,
  });
  const readerReady = !loadState.blocking;

  useEffect(() => {
    if (readerReady) enableProgressPersistence();
  }, [enableProgressPersistence, readerReady]);

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
      retryPlacement();
      return;
    }
    loadedDocIdRef.current = null;
    inFlightDocIdRef.current = null;
    setIsLoading(true);
  }, [bootstrap, loadState.retryKind, retryPlacement, retryPlaybackPlan]);

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

      // compute max horizontal padding while preserving a minimum readable width,
      // but still allow some padding on small screens
      const vw = window.innerWidth;
      const desiredMin = 640; // target readable min width
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

  // Nudge EPUB renderer to reflow on horizontal padding changes
  useEffect(() => {
    // Some EPUB renderers listen to window resize; emit a synthetic event only
    // for user-driven pad changes. Skipping initial mount avoids startup races
    // that can interrupt first-play TTS requests in tests/browsers like Firefox.
    if (!didInitPadPctRef.current) {
      didInitPadPctRef.current = true;
      return;
    }
    window.dispatchEvent(new Event('resize'));
  }, [padPct]);

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
        {epubState.currDocData ? (
          <div
            className={readerReady ? 'h-full w-full' : 'h-full w-full opacity-0 pointer-events-none'}
            aria-hidden={!readerReady}
            style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}
          >
            <EPUBViewer
              className="h-full"
              epubState={epubState}
              onError={failPlacement}
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
          documentType="epub"
          documentId={routeDocumentId || ''}
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
        epub
        isOpen={readerReady && activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={routeDocumentId || ''}
        language={language}
        detectedLanguage={metadataLanguage}
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
