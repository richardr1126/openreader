'use client';

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { HTMLViewer } from '@/components/views/HTMLViewer';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { SegmentsSidebar } from '@/components/reader/SegmentsSidebar';
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
import type { TTSAudiobookChapter } from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
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
    createFullAudioBook,
    regenerateChapter,
  } = htmlState;
  const {
    currDocPage,
    currentSentenceIndex,
    prepareInitialPosition,
    sentences,
    stop,
    setDocumentLanguage,
  } = useTTS();
  const disableProgressPersistenceRef = useLatestRef(disableProgressPersistence);
  const stopRef = useLatestRef(stop);
  const documentSettings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, bootstrap.settings);
  const language = documentSettings.language ?? 'auto';
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'segments' | 'audiobook'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(50); // 0..100 (50 = 50% default width)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);

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
    setError(bootstrap.error?.message || 'Failed to load document');
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
        prepareInitialPosition(
          bootstrap.initialPosition.location,
          bootstrap.initialPosition.sentenceIndex,
        );
      }
      await setCurrentDocument(bootstrap.document);
      loadedDocIdRef.current = resolved;
      loadSucceeded = true;
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
  }, [bootstrap.document, bootstrap.initialPosition, bootstrap.phase, enableProgressPersistence, isLoading, prepareInitialPosition, setCurrentDocument]);

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
    if (!routeDocumentId || isLoading || !isPlaybackReady || sentences.length === 0) return;
    scheduleProgress({
      documentId: routeDocumentId,
      readerType: 'html',
      location: serializeReaderPosition('html', currDocPage, currentSentenceIndex),
    });
  }, [
    currDocPage,
    currentSentenceIndex,
    isLoading,
    isPlaybackReady,
    routeDocumentId,
    scheduleProgress,
    sentences.length,
  ]);

  useEffect(() => {
    setDocumentLanguage(language);
  }, [language, setDocumentLanguage]);

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
  }, [isLoading, activeSidebar]);

  const handleGenerateAudiobook = useCallback(async (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings,
  ) => {
    return createFullAudioBook(onProgress, signal, onChapterComplete, id as string, settings.format, settings);
  }, [createFullAudioBook, id]);

  const handleRegenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    settings: AudiobookGenerationSettings,
    signal: AbortSignal,
  ) => {
    return regenerateChapter(chapterIndex, bookId, settings.format, signal, settings);
  }, [regenerateChapter]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-danger mb-4">{error}</p>
        <ButtonLink href="/app" variant="secondary" size="md" className="gap-2">
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
          <ButtonLink href="/app" variant="secondary" size="sm" className="gap-2" aria-label="Back to documents">
            <svg className="w-3 h-3" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Documents
          </ButtonLink>
        }
        title={isLoading ? 'Loading…' : (currDocName || '')}
        right={
          <div className="flex items-center gap-3">
            <DocumentHeaderMenu
              zoomLevel={padPct}
              onZoomIncrease={() => setPadPct(p => Math.min(p + 10, 100))}
              onZoomDecrease={() => setPadPct(p => Math.max(p - 10, 0))}
              onOpenSettings={() => setActiveSidebar((prev) => prev === 'settings' ? null : 'settings')}
              onOpenSegments={() => setActiveSidebar((prev) => prev === 'segments' ? null : 'segments')}
              onOpenAudiobook={() => setActiveSidebar((prev) => prev === 'audiobook' ? null : 'audiobook')}
              isSettingsOpen={activeSidebar === 'settings'}
              isSegmentsOpen={activeSidebar === 'segments'}
              isAudiobookOpen={activeSidebar === 'audiobook'}
              showAudiobookExport={canExportAudiobook}
              minZoom={0}
              maxZoom={100}
            />
          </div>
        }
      />
      <div className="overflow-hidden" style={{ height: containerHeight }}>
        {isLoading || !currDocData ? (
          <div className="p-4">
            <DocumentSkeleton />
          </div>
        ) : (
          <div className="h-full w-full" style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}>
            <HTMLViewer
              className="h-full"
              blocks={blocks}
              isTxt={isTxt}
              isLoading={isLoading}
            />
          </div>
        )}
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="html"
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
      ) : (
        <TTSPlayer isPlaybackReady={isPlaybackReady} />
      )}
      <DocumentSettings
        html
        isOpen={activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        language={language}
        onLanguageChange={(nextLanguage) => {
          void bootstrap.updateSettings({
            ...documentSettings,
            schemaVersion: 1,
            language: nextLanguage,
          });
        }}
      />
      <SegmentsSidebar
        isOpen={activeSidebar === 'segments'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'segments' : (prev === 'segments' ? null : prev))}
        documentId={id as string}
      />
    </>
  );
}
