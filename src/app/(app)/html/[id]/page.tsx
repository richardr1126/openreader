'use client';

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { HTMLViewer } from '@/components/views/HTMLViewer';
import {
  ReaderShell,
  type ReaderRendererProps,
} from '@/components/reader/ReaderShell';
import { DocumentSettings } from '@/components/documents/DocumentSettings';
import { Header } from '@/components/Header';
import { useTTS } from "@/contexts/TTSContext";
import TTSPlayer from '@/components/player/TTSPlayer';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { AudiobookExportModal } from '@/components/AudiobookExportModal';
import { VoiceSidebar } from '@/components/player/VoiceSidebar';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { ButtonLink } from '@/components/ui';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { useHtmlDocument } from './useHtmlDocument';
import { ReaderNavigationSidebars, isReaderNavigationPanel, type ReaderNavigationPanel } from '@/components/reader/ReaderNavigationSidebars';
import { useDocumentBookmarks } from '@/hooks/useDocumentBookmarks';
import type { OutlineEntry } from '@/lib/client/reader/chapters';

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
  document: sourceDocument,
  bootstrap,
  rendererReady,
  onReady,
  onError,
}: ReaderRendererProps<'html'>) {
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const routeDocumentId = payload.documentId;
  const router = useRouter();
  const { disableProgressPersistence } = bootstrap;
  const htmlState = useHtmlDocument(sourceDocument);
  const {
    currDocData,
    currDocName,
    isPlaybackReady,
    blocks,
    isTxt,
  } = htmlState;
  const {
    sentences,
    stop,
  } = useTTS();
  const documentSettings = mergeDocumentSettings(
    DEFAULT_DOCUMENT_SETTINGS,
    payload.settings,
  );
  const language = documentSettings.language ?? 'auto';
  // Markdown headings name the contents; plain text has none and reads as one flow.
  const outline = useMemo<OutlineEntry[]>(() => blocks
    .filter((block) => block.kind === 'heading')
    .map((block) => ({
      title: block.headingText || block.plainText,
      target: { readerType: 'html', location: block.anchorId },
      depth: (block.headingLevel ?? 1) - 1,
    })), [blocks]);
  const [activeSidebar, setActiveSidebar] = useState<null | 'settings' | 'audiobook' | 'voice' | ReaderNavigationPanel>(null);
  const { sentenceBookmark } = useDocumentBookmarks(routeDocumentId);
  const [containerHeight, setContainerHeight] = useState<string>('auto');
  const [padPct, setPadPct] = useState<number>(50); // 0..100 (50 = 50% default width)
  const [maxPadPx, setMaxPadPx] = useState<number>(0);

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

  const handleBackToDocuments = useCallback((event: MouseEvent) => {
    event.preventDefault();
    disableProgressPersistence();
    stop();
    setActiveSidebar(null);
    router.push('/app');
  }, [disableProgressPersistence, router, stop]);

  return (
    <>
      <Header
        left={
          <ButtonLink href="/app" variant="secondary" size="sm" className="gap-2" aria-label="Back to documents" onClick={handleBackToDocuments}>
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
              onOpenContents={() => setActiveSidebar((prev) => prev === 'contents' ? null : 'contents')}
              onOpenSearch={() => setActiveSidebar((prev) => prev === 'search' ? null : 'search')}
              onOpenBookmarks={() => setActiveSidebar((prev) => prev === 'bookmarks' ? null : 'bookmarks')}
              sentenceBookmark={sentenceBookmark}
              isSettingsOpen={activeSidebar === 'settings'}
              isContentsOpen={activeSidebar === 'contents'}
              isSearchOpen={activeSidebar === 'search'}
              isBookmarksOpen={activeSidebar === 'bookmarks'}
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
          onChangeVoice={() => setActiveSidebar('voice')}
          documentType="html"
          documentId={routeDocumentId}
        />
      )}
      {rendererReady && (
        <TTSPlayer isPlaybackReady={isPlaybackReady} hasReadableContent={sentences.length > 0} documentTitle={currDocName || payload.document.name} onOpenVoicePanel={() => setActiveSidebar('voice')} />
      )}
      <VoiceSidebar
        isOpen={activeSidebar === 'voice'}
        onClose={() => setActiveSidebar((prev) => (prev === 'voice' ? null : prev))}
      />
      <ReaderNavigationSidebars
        open={rendererReady && isReaderNavigationPanel(activeSidebar) ? activeSidebar : null}
        onClose={() => setActiveSidebar(null)}
        outline={outline}
        documentTitle={currDocName || payload.document.name}
        documentId={routeDocumentId}
      />
      <DocumentSettings
        html
        isOpen={rendererReady && activeSidebar === 'settings'}
        setIsOpen={(isOpen) => setActiveSidebar((prev) => isOpen ? 'settings' : (prev === 'settings' ? null : prev))}
        documentId={routeDocumentId}
        language={language}
        detectedLanguage={payload.document.language}
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
