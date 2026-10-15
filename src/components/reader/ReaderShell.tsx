'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
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
import { ReaderError, ReaderLoader, ReaderReplanStatus } from './ReaderLoader';

export type ReaderRendererProps<T extends ReaderType> = {
  payload: Extract<ReaderPayload, { readerType: T }>;
  document: Extract<ReaderDocument, { type: T }>;
  bootstrap: ReturnType<typeof useReaderBootstrap>;
  rendererReady: boolean;
  restartBootstrap: (command: ReaderBootstrapRestart) => void;
  onBackToDocuments: (event: MouseEvent) => void;
  onReady: () => void;
  onError: (error: Error) => void;
};

export function ReaderShell<T extends ReaderType>({
  documentId,
  readerType,
  children,
}: {
  documentId: string | undefined;
  readerType: T;
  children: (props: ReaderRendererProps<T>) => ReactNode;
}) {
  const bootstrap = useReaderBootstrap(documentId);
  const { result } = bootstrap;
  const {
    initializeReaderSession,
    adoptReplannedPlaybackPlan,
    playbackPlanKey,
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
        settings: payload.settings,
        plan: payload.plan,
        initialPosition: payload.initialPosition,
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
  useEffect(() => {
    if (!adoptedSurface || replanning || !replannedPlan || !replannedSettings) return;
    const adopted = adoptedReadyVersionRef.current;
    if (adopted?.attemptKey !== attemptKey) {
      adoptedReadyVersionRef.current = { attemptKey, version: readyVersion };
      return;
    }
    if (adopted.version === readyVersion) return;
    adoptedReadyVersionRef.current = { attemptKey, version: readyVersion };
    if (playbackPlanKey === playbackPlanIdentity(replannedPlan)) return;
    adoptReplannedPlaybackPlan({ settings: replannedSettings, plan: replannedPlan });
  }, [
    adoptReplannedPlaybackPlan,
    adoptedSurface,
    attemptKey,
    playbackPlanKey,
    readyVersion,
    replannedPlan,
    replannedSettings,
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

  // Until the reader is usable, the shell draws the header, so the way back to
  // the library works while a document prepares or after it fails.
  const statusScreen = (status: ReactNode) => (
    <main className="flex h-dvh flex-col">
      <ReaderHeader
        title={result.status === 'ready' ? result.payload.document.name : undefined}
        right={<DocumentHeaderMenu showAudiobookExport={canExportAudiobook} />}
        onBackToDocuments={backToDocuments}
      />
      <div className="grid min-h-0 flex-1">{status}</div>
    </main>
  );

  if (result.status === 'pending') {
    return statusScreen(
      <ReaderLoader progress={result.progress} />,
    );
  }

  if (result.status === 'error') {
    return statusScreen(
      <ReaderError
        error={new Error(result.message)}
        onRetry={result.retryable ? () => void bootstrap.retry() : undefined}
      />,
    );
  }

  if (result.payload.readerType !== readerType) {
    return statusScreen(
      <ReaderError
        error={new Error(`Expected a ${readerType.toUpperCase()} document, received ${result.payload.readerType}.`)}
      />,
    );
  }

  if (bootstrap.documentSource.status === 'error') {
    return statusScreen(
      <ReaderError
        error={bootstrap.documentSource.error}
        onRetry={() => void bootstrap.retryDocumentSource()}
      />,
    );
  }

  if (bootstrap.documentSource.status !== 'ready') {
    return statusScreen(
      <ReaderLoader />,
    );
  }

  if (!sourceDocument) {
    return statusScreen(
      <ReaderError
        error={new Error(`Expected ${readerType.toUpperCase()} source data, received ${bootstrap.documentSource.document.type}.`)}
      />,
    );
  }

  if (initializationError) {
    return statusScreen(
      <ReaderError error={initializationError} onRetry={retryRenderer} />,
    );
  }

  if (!payload || adoption.adoptedAttemptKey !== attemptKey) {
    return statusScreen(
      <ReaderLoader />,
    );
  }

  return (
    <>
      {rendererReady && (bootstrap.replanning || bootstrap.replanError) ? (
        <ReaderReplanStatus
          error={bootstrap.replanError}
          onRetry={() => void bootstrap.retry()}
        />
      ) : null}
      <div
        className={rendererReady ? undefined : 'pointer-events-none opacity-0'}
        aria-hidden={!rendererReady}
      >
        <Fragment key={attemptKey}>
          {children({
            payload,
            document: sourceDocument,
            bootstrap,
            rendererReady,
            restartBootstrap,
            onBackToDocuments: backToDocuments,
            onReady: handleReady,
            onError: handleError,
          })}
        </Fragment>
      </div>
      {!rendererReady || rendererError ? (
        <div className="fixed inset-0 z-50">
          {statusScreen(rendererError
            ? <ReaderError error={rendererError} onRetry={retryRenderer} />
            : <ReaderLoader />)}
        </div>
      ) : null}
    </>
  );
}
