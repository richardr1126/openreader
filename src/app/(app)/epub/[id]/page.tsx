'use client';

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from 'react';
import { EPUBViewer } from '@/components/views/EPUBViewer';
import {
  ReaderShell,
  type ReaderRendererProps,
} from '@/components/reader/ReaderShell';
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
import { ButtonLink } from '@/components/ui';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { useEpubDocument } from './useEpubDocument';

export default function EPUBPage() {
  const { id } = useParams();
  const routeDocumentId = typeof id === 'string' ? id : undefined;

  return (
    <ReaderShell documentId={routeDocumentId} readerType="epub">
      {(props) => <EpubReader {...props} />}
    </ReaderShell>
  );
}

function EpubReader({
  payload,
  document: sourceDocument,
  bootstrap,
  rendererReady,
  onReady,
  onError,
}: ReaderRendererProps<'epub'>) {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const routeDocumentId = payload.documentId;
  const {
    scheduleProgress,
  } = bootstrap;
  const initialLocator = payload.initialPosition?.readerType === 'epub'
    ? payload.initialPosition.locator
    : null;
  const epubState = useEpubDocument(sourceDocument, initialLocator, scheduleProgress);
  const {
    currDocName,
    isPlaybackReady,
    failPlacement,
    metadataLanguage,
  } = epubState;
  const {
    sentences,
  } = useTTS();
  const documentSettings = mergeDocumentSettings(
    DEFAULT_DOCUMENT_SETTINGS,
    payload.settings,
  );
  const language = documentSettings.language ?? 'auto';
  const { isAtLimit } = useAuthRateLimit();
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(100); // 0..100 (100 = full width, 0 = max padding)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const didInitPadPctRef = useRef(false);
  const handleRendererError = useCallback((error: Error) => {
    if (!rendererReady) failPlacement(error);
    onError(error);
  }, [failPlacement, onError, rendererReady]);

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
  }, [rendererReady, activeSidebar]);

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
        {epubState.currDocData ? (
          <div
            className={rendererReady ? 'h-full w-full' : 'h-full w-full opacity-0 pointer-events-none'}
            aria-hidden={!rendererReady}
            style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}
          >
            <EPUBViewer
              className="h-full"
              epubState={epubState}
              onError={handleRendererError}
              onReady={onReady}
            />
          </div>
        ) : null}
      </div>
      {canExportAudiobook && rendererReady && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="epub"
          documentId={routeDocumentId || ''}
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
        epub
        isOpen={rendererReady && activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={routeDocumentId || ''}
        language={language}
        detectedLanguage={metadataLanguage}
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
