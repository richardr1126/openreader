'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { ReaderHeader } from '@/components/reader/ReaderHeader';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import { VoiceSidebar } from '@/components/player/VoiceSidebar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import TTSPlayer from '@/components/player/TTSPlayer';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import {
  ReaderShell,
  type ReaderRendererProps,
} from '@/components/reader/ReaderShell';
import {
  FORCE_REPARSE_CONFIRM_MESSAGE,
  FORCE_REPARSE_CONFIRM_TEXT,
  FORCE_REPARSE_CONFIRM_TITLE,
} from '@/lib/client/pdf/force-reparse';
import { forceReparsePdfDocument } from '@/lib/client/api/documents';
import type { DocumentSettings as DocumentSettingsValue } from '@/types/document-settings';
import { usePdfDocument } from './usePdfDocument';
import { useConfig } from '@/contexts/ConfigContext';
import { PlanTextReader } from '@/components/views/HTMLViewer';
import { PageJumpControl, ReaderPager } from '@/components/reader/ReaderNavigator';
import { ReaderNavigationSidebars, isReaderNavigationPanel, type ReaderNavigationPanel } from '@/components/reader/ReaderNavigationSidebars';
import { useDocumentBookmarks } from '@/hooks/useDocumentBookmarks';
import { usePdfOutline } from '@/hooks/pdf/usePdfOutline';

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
  onBackToDocuments,
  onReady,
  onError,
}: ReaderRendererProps<'pdf'>) {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const routeDocumentId = payload.documentId;
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
    pdfDocument,
  } = pdfState;
  const { readerShowsLayout } = useConfig();
  const outline = usePdfOutline(pdfDocument);
  const {
    browseToLocation,
  } = useTTS();
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  // Plain-text mode reflows like EPUB, so its control sets side padding instead of page scale.
  const [padPct, setPadPct] = useState<number>(100); // 0..100 (100 = full width, 0 = max padding)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook' | 'voice' | ReaderNavigationPanel>(null);
  const { sentenceBookmark } = useDocumentBookmarks(routeDocumentId);
  const [showForceReparseConfirm, setShowForceReparseConfirm] = useState(false);
  const [isForceReparseStarting, setIsForceReparseStarting] = useState(false);
  const [containerHeight, setContainerHeight] = useState<string>('auto');

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

      const vw = window.innerWidth;
      const minContent = Math.min(640, Math.max(320, vw - 32));
      setMaxPadPx(Math.max(0, Math.floor((vw - minContent) / 2)));
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

  const sidePaddingPx = Math.round(maxPadPx * ((100 - padPct) / 100));

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
      <ReaderHeader
        onBackToDocuments={onBackToDocuments}
        title={currDocName || payload.document.name}
        right={
          <div className="flex items-center gap-2">
            <DocumentHeaderMenu
              onOpenSettings={() => setActiveSidebar((prev) => prev === 'settings' ? null : 'settings')}
              onOpenAudiobook={() => setActiveSidebar((prev) => prev === 'audiobook' ? null : 'audiobook')}
              isSettingsOpen={activeSidebar === 'settings'}
              isAudiobookOpen={activeSidebar === 'audiobook'}
              showAudiobookExport={canExportAudiobook}
              reader={rendererReady ? {
                contentsOpen: activeSidebar === 'contents',
                onToggleContents: () => setActiveSidebar((prev) => prev === 'contents' ? null : 'contents'),
                sentenceBookmark,
                onViewBookmarks: () => setActiveSidebar('bookmarks'),
                zoom: readerShowsLayout ? {
                  value: zoomLevel,
                  onIncrease: () => setZoomLevel(prev => Math.min(prev + 10, 300)),
                  onDecrease: () => setZoomLevel(prev => Math.max(prev - 10, 50)),
                  min: 50,
                  max: 300,
                } : {
                  value: padPct,
                  onIncrease: () => setPadPct(p => Math.min(p + 10, 100)),
                  onDecrease: () => setPadPct(p => Math.max(p - 10, 0)),
                  min: 0,
                  max: 100,
                },
              } : undefined}
            />
          </div>
        }
      />
      <div className="relative flex flex-col overflow-hidden" style={{ height: containerHeight }}>
        <div id="main-content" tabIndex={-1} className={rendererReady ? 'min-h-0 flex-1' : 'min-h-0 flex-1 opacity-0 pointer-events-none'}>
          {readerShowsLayout ? (
            <PDFViewer
              zoomLevel={zoomLevel}
              onReady={onReady}
              onError={onError}
              pdfState={pdfState}
            />
          ) : (
            <div className="h-full w-full" style={{ paddingLeft: `${sidePaddingPx}px`, paddingRight: `${sidePaddingPx}px` }}>
              <PlanTextReader className="h-full" readerType="pdf" onReady={onReady} onError={onError} />
            </div>
          )}
        </div>
      </div>
      {canExportAudiobook && (
        <AudiobookExportModal
          isOpen={activeSidebar === 'audiobook'}
          setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'audiobook' : (prev === 'audiobook' ? null : prev))}
          onChangeVoice={() => setActiveSidebar('voice')}
          documentType="pdf"
          documentId={routeDocumentId}
        />
      )}
      {rendererReady ? (
        <TTSPlayer isPlaybackReady={isPlaybackReady} documentTitle={currDocName || payload.document.name} onOpenVoicePanel={() => setActiveSidebar('voice')}
          navigator={currDocPages ? (
            <ReaderPager
              unit="page"
              onPrevious={() => browseToLocation(currDocPage - 1)}
              onNext={() => browseToLocation(currDocPage + 1)}
              canPrevious={currDocPage > 1}
              canNext={currDocPage < currDocPages}
              position={(
                <PageJumpControl
                  currentPage={currDocPage}
                  numPages={currDocPages}
                  onGoToPage={browseToLocation}
                />
              )}
            />
          ) : null}
        />
      ) : null}
      <VoiceSidebar
        isOpen={activeSidebar === 'voice'}
        onClose={() => setActiveSidebar((prev) => (prev === 'voice' ? null : prev))}
      />
      <DocumentSettings
        isOpen={activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={routeDocumentId}
        language={documentSettings.language ?? 'auto'}
        detectedLanguage={payload.document.language}
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
      <ReaderNavigationSidebars
        open={isReaderNavigationPanel(activeSidebar) ? activeSidebar : null}
        onClose={() => setActiveSidebar(null)}
        outline={outline}
        documentTitle={currDocName || payload.document.name}
        documentId={routeDocumentId}
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
