'use client';

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from 'react';
import { HTMLViewer } from '@/components/views/HTMLViewer';
import {
  ReaderShell,
  type ReaderRendererProps,
} from '@/components/reader/ReaderShell';
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
import { useUnmountCleanupRef } from '@/hooks/useUnmountCleanupRef';
import { ButtonLink } from '@/components/ui';
import { serializeReaderPosition } from '@/lib/shared/reader-position';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { useHtmlDocument } from './useHtmlDocument';

export default function HTMLPage() {
  const { id } = useParams();
  const routeDocumentId = typeof id === 'string' ? id : undefined;

  return (
    <ReaderShell documentId={routeDocumentId} readerType="html">
      {(props) => <HtmlReader {...props} />}
    </ReaderShell>
  );
}

function HtmlReader({
  payload,
  bootstrap,
  rendererReady,
  onReady,
  onError,
}: ReaderRendererProps<'html'>) {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const routeDocumentId = payload.documentId;
  const {
    disableProgressPersistence,
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
    documentLanguage,
    setDocumentLanguage,
    acceptBootstrapPlaybackPlan,
  } = useTTS();
  const documentSettings = mergeDocumentSettings(
    DEFAULT_DOCUMENT_SETTINGS,
    payload.settings,
  );
  const language = documentSettings.language ?? 'auto';
  const { isAtLimit } = useAuthRateLimit();
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(50); // 0..100 (50 = 50% default width)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);

  const loadDocument = useCallback(async () => {
    if (documentLanguage !== language) return;
    console.log('Loading new HTML document (from page.tsx)');
    let startedLoad = false;
    try {
      const resolved = payload.document.id;

      if (loadedDocIdRef.current === resolved) {
        return;
      }
      if (inFlightDocIdRef.current === resolved) {
        return;
      }

      startedLoad = true;
      inFlightDocIdRef.current = resolved;
      if (payload.initialPosition?.readerType === 'html') {
        prepareInitialPosition(
          payload.initialPosition.location,
          payload.initialPosition.segmentOrdinal,
        );
      }
      await acceptBootstrapPlaybackPlan(payload.plan);
      await setCurrentDocument(payload.document);
      loadedDocIdRef.current = resolved;
    } catch (err) {
      console.error('Error loading document:', err);
      onError(err instanceof Error ? err : new Error('Failed to load document'));
    } finally {
      if (startedLoad) {
        inFlightDocIdRef.current = null;
      }
    }
  }, [acceptBootstrapPlaybackPlan, documentLanguage, language, onError, payload, prepareInitialPosition, setCurrentDocument]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  const clearReaderSession = useCallback(() => {
    disableProgressPersistence();
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
    clearCurrDoc();
  }, [clearCurrDoc, disableProgressPersistence]);
  useUnmountCleanupRef(clearReaderSession);

  useEffect(() => {
    setDocumentLanguage(language);
  }, [language, setDocumentLanguage]);

  useEffect(() => {
    if (!routeDocumentId || !rendererReady || !isPlaybackReady || sentences.length === 0) return;
    scheduleProgress({
      documentId: routeDocumentId,
      readerType: 'html',
      location: serializeReaderPosition('html', currDocPage, currentSentenceOrdinal ?? 0),
    });
  }, [
    currDocPage,
    currentSentenceOrdinal,
    rendererReady,
    isPlaybackReady,
    routeDocumentId,
    scheduleProgress,
    sentences.length,
  ]);

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
  }, [rendererReady, activeSidebar]);

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
        title={currDocName || payload.document.name}
        right={rendererReady ? (
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
            className={rendererReady ? 'h-full w-full' : 'h-full w-full opacity-0 pointer-events-none'}
            aria-hidden={!rendererReady}
            style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}
          >
            <HTMLViewer
              className="h-full"
              blocks={blocks}
              isTxt={isTxt}
              onReady={onReady}
              onError={onError}
            />
          </div>
        ) : null}
      </div>
      {canExportAudiobook && rendererReady && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="html"
          documentId={routeDocumentId}
        />
      )}
      {rendererReady && (isAtLimit ? (
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
        isOpen={rendererReady && activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={routeDocumentId}
        language={language}
        onLanguageChange={(nextLanguage) => {
          void bootstrap.updateSettings({
            ...documentSettings,
            schemaVersion: 1,
            language: nextLanguage,
          });
        }}
      />
    </>
  );
}
