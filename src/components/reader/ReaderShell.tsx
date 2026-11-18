'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { DocumentHeaderMenu } from '@/components/documents/DocumentHeaderMenu';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';
import { useReaderSurfaceAdoption } from '@/hooks/useReaderSurfaceAdoption';
import { readerSurfaceKey } from '@/lib/client/reader-readiness/surface-key';
import { playbackPlanIdentity } from '@/lib/shared/playback-plan';
import { readingPositionAt } from '@/lib/shared/reading-position';
import type {
  ReaderBootstrapRestart,
  ReaderPayload,
} from '@/types/reader-bootstrap';
import type { ReaderDocument } from '@/types/documents';
import type { ReaderType } from '@/types/user-state';
import { ReaderHeader } from './ReaderHeader';
import { ReaderAppearanceProvider } from '@/contexts/ReaderAppearanceContext';
import { ReaderError, ReaderLoader, ReaderReplanStatus } from './ReaderLoader';
import { AccessRequiredCard } from '@/components/auth/AccessRequiredCard';
import { useAuthSession } from '@/hooks/useAuthSession';

export type ReaderRendererProps<T extends ReaderType> = {
  payload: Extract<ReaderPayload, { readerType: T }>;
  document: Extract<ReaderDocument, { type: T }>;
  bootstrap: ReturnType<typeof useReaderBootstrap>;
  rendererReady: boolean;
  restartBootstrap: (command: ReaderBootstrapRestart) => void;
  headerActions: HTMLElement | null;
  onReady: () => void;
  onError: (error: Error) => void;
};

export function ReaderShell<T extends ReaderType>({
  documentId,
  readerType,
  renderer: Renderer,
}: {
  documentId: string | undefined;
  readerType: T;
  renderer: ComponentType<ReaderRendererProps<T>>;
}) {
  const bootstrap = useReaderBootstrap(documentId);
  const { data: session } = useAuthSession();
  const { result } = bootstrap;
  const {
    initializeReaderSession,
    adoptReplannedPlaybackPlan,
    playbackPlanKey,
    playbackPlanPayload,
    currentSentenceOrdinal,
    playbackSegments,
    stop,
  } = useTTS();
  const router = useRouter();
  const canExportAudiobook = useFeatureFlag('enableAudiobookExport');
  const {
    disableProgressPersistence,
    enableProgressPersistence,
    restart: restartBootstrapQuery,
    scheduleProgress,
  } = bootstrap;
  const surfaceKey = result.status === 'ready'
    ? readerSurfaceKey(result.payload)
    : documentId ?? '';
  const [readyAttemptKey, setReadyAttemptKey] = useState<string | null>(null);
  const [rendererFailure, setRendererFailure] = useState<{
    attemptKey: string;
    error: Error;
  } | null>(null);
  const [rendererAttempt, setRendererAttempt] = useState(0);
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null);
  const advanceRendererAttempt = useCallback(() => {
    setRendererAttempt((current) => current + 1);
  }, []);
  const restartBootstrap = useCallback((command: ReaderBootstrapRestart) => {
    disableProgressPersistence();
    setReadyAttemptKey(null);
    setRendererFailure(null);
    restartBootstrapQuery(command);
    advanceRendererAttempt();
  }, [advanceRendererAttempt, disableProgressPersistence, restartBootstrapQuery]);
  const attemptKey = `${surfaceKey}:${rendererAttempt}`;
  const rendererReady = readyAttemptKey === attemptKey;
  const payload = result.status === 'ready' && result.payload.readerType === readerType
    ? result.payload as Extract<ReaderPayload, { readerType: T }>
    : null;
  const sourceDocument = bootstrap.documentSource.status === 'ready'
    && bootstrap.documentSource.document.type === readerType
    ? bootstrap.documentSource.document as Extract<ReaderDocument, { type: T }>
    : null;
  const adoption = useReaderSurfaceAdoption({
    attemptKey,
    enabled: Boolean(payload && sourceDocument),
    adopt: () => {
      if (!payload) return;
      initializeReaderSession({
        readerType,
        documentLanguage: payload.document.language ?? null,
        settings: payload.settings,
        plan: payload.plan,
        playback: payload.playback,
        initialPosition: payload.initialPosition,
        onSettingsSaved: bootstrap.acknowledgeSettings,
      });
    },
  });
  // Each later ready result for the same surface (a re-plan) swaps its plan into
  // the mounted reader. The initial adoption above owns the first result.
  const adoptedReadyVersionRef = useRef<{ attemptKey: string; version: number } | null>(null);
  const adoptedSurface = Boolean(payload) && adoption.adoptedAttemptKey === attemptKey;
  const readyVersion = bootstrap.readyVersion;
  const replanning = bootstrap.replanning;
  const replannedPlan = payload?.plan;
  const replannedSettings = payload?.settings;
  const replannedPlayback = payload?.playback;
  const replannedDocumentLanguage = payload?.document.language ?? null;
  useEffect(() => {
    if (!adoptedSurface || replanning || !replannedPlan || !replannedSettings || !replannedPlayback) return;
    const adopted = adoptedReadyVersionRef.current;
    if (adopted?.attemptKey !== attemptKey) {
      adoptedReadyVersionRef.current = { attemptKey, version: readyVersion };
      return;
    }
    if (adopted.version === readyVersion) return;
    adoptedReadyVersionRef.current = { attemptKey, version: readyVersion };
    if (playbackPlanKey === playbackPlanIdentity(replannedPlan)
      && JSON.stringify(playbackPlanPayload) === JSON.stringify(replannedPlayback.request)) return;
    adoptReplannedPlaybackPlan({ settings: replannedSettings, plan: replannedPlan, playback: replannedPlayback, documentLanguage: replannedDocumentLanguage });
  }, [
    adoptReplannedPlaybackPlan,
    adoptedSurface,
    attemptKey,
    playbackPlanKey,
    playbackPlanPayload,
    readyVersion,
    replannedPlan,
    replannedSettings,
    replannedDocumentLanguage,
    replannedPlayback,
    replanning,
  ]);
  const initializationError = adoption.failure?.attemptKey === attemptKey
    ? adoption.failure.error
    : null;
  const rendererError = rendererFailure?.attemptKey === attemptKey
    ? rendererFailure.error
    : initializationError;

  useEffect(() => {
    disableProgressPersistence();
  }, [attemptKey, disableProgressPersistence]);

  // Reading progress is the committed playback cursor, for every reader type.
  // Persistence is enabled only once the renderer has placed the saved
  // position, so startup never overwrites it.
  useEffect(() => {
    if (!documentId || !rendererReady || currentSentenceOrdinal === null) return;
    const position = readingPositionAt(playbackSegments, currentSentenceOrdinal);
    if (position) scheduleProgress({ documentId, ...position });
  }, [currentSentenceOrdinal, documentId, playbackSegments, rendererReady, scheduleProgress]);

  const handleReady = useCallback(() => {
    setReadyAttemptKey(attemptKey);
    setRendererFailure(null);
    enableProgressPersistence();
  }, [attemptKey, enableProgressPersistence]);

  const handleError = useCallback((error: Error) => {
    // The shell owns initial reveal only. Renderer mechanics after the first
    // usable surface must not restart bootstrap or hide an established reader.
    if (readyAttemptKey === attemptKey) return;
    disableProgressPersistence();
    setRendererFailure({ attemptKey, error });
  }, [attemptKey, disableProgressPersistence, readyAttemptKey]);

  const retryRenderer = useCallback(() => {
    disableProgressPersistence();
    setReadyAttemptKey(null);
    setRendererFailure(null);
    advanceRendererAttempt();
  }, [advanceRendererAttempt, disableProgressPersistence]);

  const navigatingBackRef = useRef(false);
  const backToDocuments = useCallback((event: MouseEvent) => {
    event.preventDefault();
    if (navigatingBackRef.current) return;
    navigatingBackRef.current = true;
    disableProgressPersistence();
    stop();
    router.push('/app');
  }, [disableProgressPersistence, router, stop]);

  // One header survives every startup/renderer transition. Replacing the
  // loading header during a pointer press can discard its eventual click.
  const canMountRenderer = payload && sourceDocument
    && adoption.adoptedAttemptKey === attemptKey && !initializationError;
  let status: ReactNode = null;
  if (result.status === 'pending') {
    status = <ReaderLoader progress={result.progress} />;
  } else if (result.status === 'error' && result.notFound) {
    status = <AccessRequiredCard subject="document" accountName={session?.user && !session.user.isAnonymous ? session.user.name : null} />;
  } else if (result.status === 'error') {
    status = (
      <ReaderError
        error={bootstrap.retryError ?? new Error(result.message)}
        onRetry={result.retryable ? () => void bootstrap.retry() : undefined}
        retrying={bootstrap.retrying}
      />
    );
  } else if (result.payload.readerType !== readerType) {
    status = (
      <ReaderError
        error={new Error(`Expected a ${readerType.toUpperCase()} document, received ${result.payload.readerType}.`)}
      />
    );
  } else if (bootstrap.documentSource.status === 'error') {
    status = (
      <ReaderError
        error={bootstrap.documentSource.error}
        onRetry={() => void bootstrap.retryDocumentSource()}
      />
    );
  } else if (bootstrap.documentSource.status !== 'ready') {
    status = <ReaderLoader />;
  } else if (!sourceDocument) {
    status = (
      <ReaderError
        error={new Error(`Expected ${readerType.toUpperCase()} source data, received ${bootstrap.documentSource.document.type}.`)}
      />
    );
  } else if (initializationError) {
    status = <ReaderError error={initializationError} onRetry={retryRenderer} />;
  } else if (!canMountRenderer || !rendererReady || rendererError) {
    status = rendererError
      ? <ReaderError error={rendererError} onRetry={retryRenderer} />
      : <ReaderLoader />;
  }

  return (
    <div className="flex h-dvh flex-col">
      <ReaderHeader
        title={payload?.document.name}
        right={result.status === 'error' && result.notFound ? null : (
          <div ref={setHeaderActions} className="contents">
            {!canMountRenderer || !rendererReady ? <DocumentHeaderMenu showAudiobookExport={canExportAudiobook} /> : null}
          </div>
        )}
        onBackToDocuments={backToDocuments}
      />
      {rendererReady && (bootstrap.replanning || bootstrap.replanError) ? (
        <ReaderReplanStatus
          error={bootstrap.replanError}
          onRetry={() => void bootstrap.retry()}
        />
      ) : null}
      <div className="relative min-h-0 flex-1">
        {canMountRenderer ? (
          <div
            className={rendererReady ? undefined : 'pointer-events-none opacity-0'}
            aria-hidden={!rendererReady}
          >
            <Fragment key={attemptKey}>
              <ReaderAppearanceProvider readerType={readerType} settings={payload.settings} update={bootstrap.updatePresentation}>
                <Renderer
                  payload={payload}
                  document={sourceDocument}
                  bootstrap={bootstrap}
                  rendererReady={rendererReady}
                  restartBootstrap={restartBootstrap}
                  headerActions={headerActions}
                  onReady={handleReady}
                  onError={handleError}
                />
              </ReaderAppearanceProvider>
            </Fragment>
          </div>
        ) : null}
        {status ? <div className="absolute inset-0 grid">{status}</div> : null}
      </div>
    </div>
  );
}
