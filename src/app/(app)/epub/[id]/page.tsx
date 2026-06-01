'use client';

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { EPUBViewer } from '@/components/views/EPUBViewer';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { SegmentsSidebar } from '@/components/reader/SegmentsSidebar';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
import { resolveDocumentId } from '@/lib/client/dexie';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useUnmountCleanupRef } from '@/hooks/useUnmountCleanupRef';
import { ButtonLink } from '@/components/ui';
import { useEpubDocument } from './useEpubDocument';

export default function EPUBPage() {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const { id } = useParams();
  const router = useRouter();
  const routeDocumentId = typeof id === 'string' ? id : undefined;
  const epubState = useEpubDocument(routeDocumentId);
  const {
    setCurrentDocument,
    currDocName,
    clearCurrDoc,
    createFullAudioBook: createEPUBAudioBook,
    regenerateChapter: regenerateEPUBChapter,
    bookRef,
  } = epubState;
  const { stop } = useTTS();
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook' | 'segments'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(100); // 0..100 (100 = full width, 0 = max padding)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);
  const didInitPadPctRef = useRef(false);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setActiveSidebar(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [routeDocumentId]);

  const loadDocument = useCallback(async () => {
    console.log('Loading new epub (from page.tsx)');
    let didRedirect = false;
    let startedLoad = false;
    try {
      if (!routeDocumentId) {
        setError('Document not found');
        return;
      }
      const resolved = await resolveDocumentId(routeDocumentId);
      if (resolved !== routeDocumentId) {
        didRedirect = true;
        router.replace(`/epub/${resolved}`);
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
      await setCurrentDocument(resolved);
      loadedDocIdRef.current = resolved;
    } catch (err) {
      console.error('Error loading document:', err);
      setError('Failed to load document');
    } finally {
      if (startedLoad) {
        inFlightDocIdRef.current = null;
      }
      if (!didRedirect && startedLoad) {
        setIsLoading(false);
      }
    }
  }, [routeDocumentId, router, setCurrentDocument, stop]);

  useEffect(() => {
    if (!isLoading) return;

    loadDocument();
  }, [loadDocument, isLoading]);

  useUnmountCleanupRef(clearCurrDoc);

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
  }, [isLoading, activeSidebar]);

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

  const handleGenerateAudiobook = useCallback(async (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings
  ) => {
    return createEPUBAudioBook(onProgress, signal, onChapterComplete, routeDocumentId, settings.format, settings);
  }, [createEPUBAudioBook, routeDocumentId]);

  const handleRegenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    settings: AudiobookGenerationSettings,
    signal: AbortSignal
  ) => {
    return regenerateEPUBChapter(chapterIndex, bookId, settings.format, signal, settings);
  }, [regenerateEPUBChapter]);

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
              onOpenAudiobook={() => setActiveSidebar((prev) => prev === 'audiobook' ? null : 'audiobook')}
              onOpenSegments={() => setActiveSidebar((prev) => prev === 'segments' ? null : 'segments')}
              isSettingsOpen={activeSidebar === 'settings'}
              isAudiobookOpen={activeSidebar === 'audiobook'}
              isSegmentsOpen={activeSidebar === 'segments'}
              showAudiobookExport={canExportAudiobook}
              minZoom={0}
              maxZoom={100}
            />
          </div>
        }
      />
      <div className="overflow-hidden" style={{ height: containerHeight }}>

        {isLoading ? (
          <div className="p-4">
            <DocumentSkeleton />
          </div>
        ) : (
          <div className="h-full w-full" style={{ paddingLeft: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px`, paddingRight: `${Math.round(maxPadPx * ((100 - padPct) / 100))}px` }}>
            <EPUBViewer className="h-full" epubState={epubState} />
          </div>
        )}
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="epub"
          documentId={routeDocumentId || ''}
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
        <TTSPlayer />
      )}
      <DocumentSettings
        epub
        isOpen={activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
      />
      <SegmentsSidebar
        isOpen={activeSidebar === 'segments'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'segments' : (prev === 'segments' ? null : prev))}
        documentId={routeDocumentId || ''}
        epubBookRef={bookRef}
      />
    </>
  );
}
