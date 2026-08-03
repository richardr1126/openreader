'use client';

import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import toast from 'react-hot-toast';
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
import {
  ReaderShell,
  type ReaderRendererProps,
} from '@/components/reader/ReaderShell';
import { ButtonLink } from '@/components/ui';
import {
  FORCE_REPARSE_CONFIRM_MESSAGE,
  FORCE_REPARSE_CONFIRM_TEXT,
  FORCE_REPARSE_CONFIRM_TITLE,
} from '@/lib/client/pdf/force-reparse';
import { forceReparsePdfDocument } from '@/lib/client/api/documents';
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
  const { id } = useParams();
  const routeDocumentId = typeof id === 'string' ? id : undefined;

  return (
    <ReaderShell documentId={routeDocumentId} readerType="pdf">
      {(props) => <PdfReader {...props} />}
    </ReaderShell>
  );
}

function PdfReader({
  payload,
  document: sourceDocument,
  bootstrap,
  rendererReady,
  restartBootstrap,
  onReady,
  onError,
}: ReaderRendererProps<'pdf'>) {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const routeDocumentId = payload.documentId;
  const router = useRouter();
  const {
    disableProgressPersistence,
    scheduleProgress,
  } = bootstrap;
  const pdfState = usePdfDocument(
    sourceDocument,
    payload.settings,
    payload.parsedDocument,
    bootstrap.updateSettings,
  );
  const {
    currDocName,
    currDocPage,
    currDocPages,
    isPlaybackReady,
    documentSettings,
    updateDocumentSettings,
    parsedOverlayEnabled,
    setParsedOverlayEnabled,
  } = pdfState;
  const {
    currentSentenceOrdinal,
    sentences,
    stop,
    setPdfSkipBlockKinds,
  } = useTTS();
  const { isAtLimit } = useAuthRateLimit();
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook'>(null);
  const [showForceReparseConfirm, setShowForceReparseConfirm] = useState(false);
  const [isForceReparseStarting, setIsForceReparseStarting] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [isNavigatingBack, setIsNavigatingBack] = useState(false);
  useEffect(() => {
    setPdfSkipBlockKinds(documentSettings.pdf?.skipBlockKinds ?? []);
  }, [documentSettings.pdf?.skipBlockKinds, setPdfSkipBlockKinds]);

  useEffect(() => {
    if (!routeDocumentId || !rendererReady || !isPlaybackReady || sentences.length === 0) return;
    scheduleProgress({
      documentId: routeDocumentId,
      readerType: 'pdf',
      location: serializeReaderPosition('pdf', currDocPage, currentSentenceOrdinal ?? 0),
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
  }, [rendererReady, isAtLimit, activeSidebar]);

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
    setShowForceReparseConfirm(true);
  }, []);

  const confirmForceReparse = useCallback(async () => {
    setShowForceReparseConfirm(false);
    setIsForceReparseStarting(true);
    const toastId = toast.loading('Starting PDF reparse…');
    try {
      const restart = await forceReparsePdfDocument(routeDocumentId);
      setIsForceReparseStarting(false);
      toast.success('PDF reparse started.', { id: toastId });
      restartBootstrap(restart);
    } catch (error) {
      setIsForceReparseStarting(false);
      toast.error(
        error instanceof Error ? error.message : 'Failed to reparse PDF',
        { id: toastId },
      );
    }
  }, [restartBootstrap, routeDocumentId]);

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
        title={currDocName || payload.document.name}
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
        <div className={rendererReady ? 'h-full' : 'h-full opacity-0 pointer-events-none'}>
          <PDFViewer
            zoomLevel={zoomLevel}
            onReady={onReady}
            onError={onError}
            pdfState={pdfState}
          />
        </div>
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          documentType="pdf"
          documentId={routeDocumentId}
        />
      )}
      {isAtLimit ? (
        <div className="sticky bottom-0 z-30 w-full border-t border-line-soft bg-surface" data-app-ttsbar>
          <div className="px-2 md:px-3 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-1 min-h-10">
            <RateLimitPauseButton />
            <RateLimitBanner />
          </div>
        </div>
      ) : rendererReady ? (
        <TTSPlayer currentPage={currDocPage} numPages={currDocPages} isPlaybackReady={isPlaybackReady} />
      ) : null}
      <DocumentSettings
        isOpen={activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={routeDocumentId}
        language={documentSettings.language ?? 'auto'}
        onLanguageChange={(language) => {
          const nextSettings: DocumentSettingsValue = {
            ...documentSettings,
            schemaVersion: 1,
            language,
          };
          void updateDocumentSettings(nextSettings);
        }}
        pdf={{
          parseStatus: isForceReparseStarting ? 'running' : 'ready',
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
            void updateDocumentSettings(nextSettings);
          },
          onForceReparse: requestForceReparse,
        }}
      />
      <ConfirmDialog
        isOpen={showForceReparseConfirm}
        onClose={() => setShowForceReparseConfirm(false)}
        onConfirm={() => void confirmForceReparse()}
        title={FORCE_REPARSE_CONFIRM_TITLE}
        message={FORCE_REPARSE_CONFIRM_MESSAGE}
        confirmText={FORCE_REPARSE_CONFIRM_TEXT}
        cancelText="Cancel"
      />
    </>
  );
}
