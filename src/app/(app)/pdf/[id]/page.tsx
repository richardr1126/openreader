'use client';

import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { DocumentSkeleton } from '@/components/documents/DocumentSkeleton';
import { useTTS } from '@/contexts/TTSContext';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { SegmentsSidebar } from '@/components/reader/SegmentsSidebar';
import { Header } from '@/components/Header';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { AudiobookGenerationSettings } from '@/types/client';
import TTSPlayer from '@/components/player/TTSPlayer';
import { RateLimitPauseButton } from '@/components/player/RateLimitPauseButton';
import { resolveDocumentId } from '@/lib/client/dexie';
import { RateLimitBanner } from '@/components/auth/RateLimitBanner';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { LoadingSpinner } from '@/components/Spinner';
import { usePdfDocument } from './usePdfDocument';

// Dynamic import for client-side rendering only
const PDFViewer = dynamic(
  () => import('@/components/views/PDFViewer').then((module) => module.PDFViewer),
  {
    ssr: false,
    loading: () => <DocumentSkeleton />
  }
);

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
    parseStatus,
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
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook' | 'segments'>(null);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const inFlightDocIdRef = useRef<string | null>(null);
  const loadedDocIdRef = useRef<string | null>(null);
  const backNavTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCurrDocRef = useRef(clearCurrDoc);
  const [isNavigatingBack, setIsNavigatingBack] = useState(false);
  const parseState = parseStatus ?? 'pending';
  const isParseReady = parseState === 'ready';

  useEffect(() => {
    setIsLoading(true);
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

  useEffect(() => {
    clearCurrDocRef.current = clearCurrDoc;
  }, [clearCurrDoc]);

  useEffect(() => {
    return () => {
      if (backNavTimeoutRef.current) {
        clearTimeout(backNavTimeoutRef.current);
      }
      clearCurrDocRef.current();
    };
  }, []);

  useEffect(() => {
    if (isLoading) return;
    if (isParseReady) return;
    stop();
  }, [isLoading, isParseReady, stop]);

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
    const hadOpenSidebar = activeSidebar !== null;
    setActiveSidebar(null);
    const delayMs = hadOpenSidebar ? 220 : 0;
    if (backNavTimeoutRef.current) {
      clearTimeout(backNavTimeoutRef.current);
    }
    backNavTimeoutRef.current = setTimeout(() => {
      router.push('/app');
    }, delayMs);
  }, [isNavigatingBack, stop, activeSidebar, router]);

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
        <p className="text-red-500 mb-4">{error}</p>
        <Link
          href="/app"
          onClick={handleBackToDocuments}
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

  const renderPdfStatusLoader = () => {
    let statusText = 'Loading PDF...';
    if (!isLoading) {
      if (parseState === 'pending') {
        statusText = 'Preparing PDF layout...';
      } else if (parseState === 'running') {
        statusText = 'Parsing PDF layout blocks...';
      } else if (parseState === 'failed') {
        statusText = 'PDF parsing failed. Retry to continue.';
      }
    }

    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-base">
        <LoadingSpinner className="w-8 h-8 text-accent" />
        <p className="text-sm text-muted animate-pulse">{statusText}</p>
        {!isLoading && parseState === 'failed' ? (
          <button
            type="button"
            onClick={() => forceReparseParsedPdf()}
            className="inline-flex items-center rounded-md border border-offbase bg-offbase px-2.5 py-1 text-xs text-foreground hover:text-accent transition-colors"
          >
            Retry Parse
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <Header
        left={
          <Link
            href="/app"
            onClick={handleBackToDocuments}
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
      <div className="overflow-hidden" style={{ height: containerHeight }}>
        {isLoading || !isParseReady ? (
          renderPdfStatusLoader()
        ) : (
          <PDFViewer zoomLevel={zoomLevel} pdfState={pdfState} />
        )}
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
        <div className="sticky bottom-0 z-30 w-full border-t border-offbase bg-base" data-app-ttsbar>
          <div className="px-2 md:px-3 pt-1 pb-1.5 flex items-center justify-center gap-1 min-h-10">
            <RateLimitPauseButton />
            <RateLimitBanner />
          </div>
        </div>
      ) : isParseReady ? (
        <TTSPlayer currentPage={currDocPage} numPages={currDocPages} />
      ) : null}
      <DocumentSettings
        isOpen={activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        pdf={{
          parseStatus,
          parsedOverlayEnabled,
          skipBlockKinds: documentSettings.pdf?.skipBlockKinds ?? [],
          chaptersFromSections: documentSettings.pdf?.chaptersFromSections ?? true,
          onToggleOverlay: (enabled) => setParsedOverlayEnabled(enabled),
          onToggleSkipKind: (kind, enabled) => {
            const current = new Set(documentSettings.pdf?.skipBlockKinds ?? []);
            if (enabled) current.add(kind);
            else current.delete(kind);
            void updateDocumentSettings({
              ...documentSettings,
              schemaVersion: 1,
              pdf: {
                ...(documentSettings.pdf ?? { chaptersFromSections: true }),
                skipBlockKinds: Array.from(current),
                chaptersFromSections: documentSettings.pdf?.chaptersFromSections ?? true,
              },
            });
          },
          onToggleChaptersFromSections: (enabled) => {
            void updateDocumentSettings({
              ...documentSettings,
              schemaVersion: 1,
              pdf: {
                ...(documentSettings.pdf ?? { skipBlockKinds: [] }),
                skipBlockKinds: documentSettings.pdf?.skipBlockKinds ?? [],
                chaptersFromSections: enabled,
              },
            });
          },
          onForceReparse: () => forceReparseParsedPdf(),
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
