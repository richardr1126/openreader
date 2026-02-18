'use client';

import { useParams, useRouter } from "next/navigation";
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEPUB } from '@/contexts/EPUBContext';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { EPUBViewer } from '@/components/views/EPUBViewer';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
import { resolveDocumentId } from '@/lib/dexie';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';

const canExportAudiobook = process.env.NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT !== 'false';

export default function EPUBPage() {
  const { id } = useParams();
  const router = useRouter();
  const { setCurrentDocument, currDocName, clearCurrDoc, createFullAudioBook: createEPUBAudioBook, regenerateChapter: regenerateEPUBChapter } = useEPUB();
  const { stop } = useTTS();
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAudiobookModalOpen, setIsAudiobookModalOpen] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(100); // 0..100 (100 = full width, 0 = max padding)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [id]);

  const loadDocument = useCallback(async () => {
    console.log('Loading new epub (from page.tsx)');
    let didRedirect = false;
    let startedLoad = false;
    try {
      if (!id) {
        setError('Document not found');
        return;
      }
      const resolved = await resolveDocumentId(id as string);
      if (resolved !== (id as string)) {
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
  }, [id, router, setCurrentDocument, stop]);

  useEffect(() => {
    if (!isLoading) return;

    loadDocument();
  }, [loadDocument, isLoading]);

  // Compute available height = viewport - (header height + tts bar height)
  useEffect(() => {
    const compute = () => {
      const header = document.querySelector('[data-app-header]') as HTMLElement | null;
      const ttsbar = document.querySelector('[data-app-ttsbar]') as HTMLElement | null;
      const headerH = header ? header.getBoundingClientRect().height : 0;
      const ttsH = ttsbar ? ttsbar.getBoundingClientRect().height : 0;
      const vh = window.innerHeight;
      const h = Math.max(0, vh - headerH - ttsH);
      setContainerHeight(`${h}px`);

      // compute max horizontal padding while preserving a minimum readable width,
      // but still allow some padding on small screens
      const vw = window.innerWidth;
      const desiredMin = 640; // target readable min width
      const minContent = Math.min(desiredMin, Math.max(320, vw - 32));
      const maxPad = Math.max(0, Math.floor((vw - minContent) / 2));
      setMaxPadPx(maxPad);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  // Nudge EPUB renderer to reflow on horizontal padding changes
  useEffect(() => {
    // Some EPUB renderers listen to window resize; emit a synthetic event
    window.dispatchEvent(new Event('resize'));
  }, [padPct]);

  const handleGenerateAudiobook = useCallback(async (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings
  ) => {
    return createEPUBAudioBook(onProgress, signal, onChapterComplete, id as string, settings.format, settings);
  }, [createEPUBAudioBook, id]);

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
        <p className="text-red-500 mb-4">{error}</p>
        <Link
          href="/app"
          onClick={() => clearCurrDoc()}
          className="inline-flex items-center px-3 py-1 bg-base text-foreground rounded-lg hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.04] hover:text-accent"
        >
          <svg className="w-4 h-4 mr-2 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Documents
        </Link>
      </div>
    );
  }

  return (
    <>
      <Header
        left={
          <Link
            href="/app"
            onClick={() => clearCurrDoc()}
            className="inline-flex items-center py-1 px-2 rounded-md border border-offbase bg-base text-foreground text-xs hover:bg-offbase transition-all duration-200 ease-in-out hover:scale-[1.04] hover:text-accent"
            aria-label="Back to documents"
          >
            <svg className="w-3 h-3 mr-2" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Documents
          </Link>
        }
        title={isLoading ? 'Loading…' : (currDocName || '')}
        right={
          <div className="flex items-center gap-3">
            <DocumentHeaderMenu
              zoomLevel={padPct}
              onZoomIncrease={() => setPadPct(p => Math.min(p + 10, 100))}
              onZoomDecrease={() => setPadPct(p => Math.max(p - 10, 0))}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onOpenAudiobook={() => setIsAudiobookModalOpen(true)}
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
            <EPUBViewer className="h-full" />
          </div>
        )}
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={isAudiobookModalOpen}
          setIsOpen={setIsAudiobookModalOpen}
          documentType="epub"
          documentId={id as string}
          onGenerateAudiobook={handleGenerateAudiobook}
          onRegenerateChapter={handleRegenerateChapter}
        />
      )}
      {isAtLimit ? (
        <div className="sticky bottom-0 z-30 w-full border-t border-offbase bg-base" data-app-ttsbar>
          <div className="px-2 md:px-3 pt-1 pb-1.5 flex items-center justify-center gap-1 min-h-10">
            <RateLimitPauseButton />
            <RateLimitBanner />
          </div>
        </div>
      ) : (
        <TTSPlayer />
      )}
      <DocumentSettings epub isOpen={isSettingsOpen} setIsOpen={setIsSettingsOpen} />
    </>
  );
}
