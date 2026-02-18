'use client';

import dynamic from 'next/dynamic';
import { usePDF } from '@/contexts/PDFContext';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { useTTS } from '@/contexts/TTSContext';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { Header } from '@/components/Header';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { resolveDocumentId } from '@/lib/dexie';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';

const canExportAudiobook = process.env.NEXT_PUBLIC_ENABLE_AUDIOBOOK_EXPORT !== 'false';

// Dynamic import for client-side rendering only
const PDFViewer = dynamic(
  () => import('@/components/views/PDFViewer').then((module) => module.PDFViewer),
  {
    ssr: false,
    loading: () => <DocumentSkeleton />
  }
);

export default function PDFViewerPage() {
  const { id } = useParams();
  const router = useRouter();
  const { setCurrentDocument, currDocName, clearCurrDoc, currDocPage, currDocPages, createFullAudioBook: createPDFAudioBook, regenerateChapter: regeneratePDFChapter } = usePDF();
  const { stop } = useTTS();
  const { isAtLimit } = useAuthRateLimit();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAudiobookModalOpen, setIsAudiobookModalOpen] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    inFlightDocIdRef.current = null;
    loadedDocIdRef.current = null;
  }, [id]);

  const loadDocument = useCallback(async () => {
    if (!isLoading) return; // Prevent calls when not loading new doc
    console.log('Loading new document (from page.tsx)');
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
  }, [isLoading, id, router, setCurrentDocument, stop]);

  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

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
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 10, 300));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 10, 50));

  const handleGenerateAudiobook = useCallback(async (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings
  ) => {
    return createPDFAudioBook(onProgress, signal, onChapterComplete, id as string, settings.format, settings);
  }, [createPDFAudioBook, id]);

  const handleRegenerateChapter = useCallback(async (
    chapterIndex: number,
    bookId: string,
    settings: AudiobookGenerationSettings,
    signal: AbortSignal
  ) => {
    return regeneratePDFChapter(chapterIndex, bookId, settings.format, signal, settings);
  }, [regeneratePDFChapter]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-red-500 mb-4">{error}</p>
        <Link
          href="/app"
          onClick={() => { clearCurrDoc(); }}
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
          <div className="flex items-center gap-2">
            <DocumentHeaderMenu
              zoomLevel={zoomLevel}
              onZoomIncrease={handleZoomIn}
              onZoomDecrease={handleZoomOut}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onOpenAudiobook={() => setIsAudiobookModalOpen(true)}
              showAudiobookExport={canExportAudiobook}
              minZoom={50}
              maxZoom={300}
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
          <PDFViewer zoomLevel={zoomLevel} />
        )}
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={isAudiobookModalOpen}
          setIsOpen={setIsAudiobookModalOpen}
          documentType="pdf"
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
        <TTSPlayer currentPage={currDocPage} numPages={currDocPages} />
      )}
      <DocumentSettings isOpen={isSettingsOpen} setIsOpen={setIsSettingsOpen} />
    </>
  );
}
