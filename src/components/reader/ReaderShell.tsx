'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useTTS } from '@/contexts/TTSContext';
import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';
import { useReaderSurfaceAdoption } from '@/hooks/useReaderSurfaceAdoption';
import { readerSurfaceKey } from '@/lib/client/reader-readiness/surface-key';
import type {
  ReaderBootstrapRestart,
  ReaderPayload,
} from '@/types/reader-bootstrap';
import type { ReaderDocument } from '@/types/documents';
import type { ReaderType } from '@/types/user-state';
import { ReaderError, ReaderLoader } from './ReaderLoader';

export type ReaderRendererProps<T extends ReaderType> = {
  payload: Extract<ReaderPayload, { readerType: T }>;
  document: Extract<ReaderDocument, { type: T }>;
  bootstrap: ReturnType<typeof useReaderBootstrap>;
  rendererReady: boolean;
  restartBootstrap: (command: ReaderBootstrapRestart) => void;
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
  const { initializeReaderSession } = useTTS();
  const {
    disableProgressPersistence,
    enableProgressPersistence,
    restart: restartBootstrapQuery,
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
        language: payload.settings.language ?? 'auto',
        plan: payload.plan,
        initialPosition: payload.initialPosition,
      });
    },
  });
  const initializationError = adoption.failure?.attemptKey === attemptKey
    ? adoption.failure.error
    : null;
  const rendererError = rendererFailure?.attemptKey === attemptKey
    ? rendererFailure.error
    : initializationError;

  useEffect(() => {
    disableProgressPersistence();
  }, [attemptKey, disableProgressPersistence]);

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

  if (result.status === 'pending') {
    return (
      <main className="min-h-screen">
        <ReaderLoader progress={result.progress} />
      </main>
    );
  }

  if (result.status === 'error') {
    return (
      <main className="min-h-screen">
        <ReaderError
          error={new Error(result.message)}
          onRetry={result.retryable ? () => void bootstrap.retry() : undefined}
        />
      </main>
    );
  }

  if (result.payload.readerType !== readerType) {
    return (
      <main className="min-h-screen">
        <ReaderError
          error={new Error(`Expected a ${readerType.toUpperCase()} document, received ${result.payload.readerType}.`)}
        />
      </main>
    );
  }

  if (bootstrap.documentSource.status === 'error') {
    return (
      <main className="min-h-screen">
        <ReaderError
          error={bootstrap.documentSource.error}
          onRetry={() => void bootstrap.retryDocumentSource()}
        />
      </main>
    );
  }

  if (bootstrap.documentSource.status !== 'ready') {
    return (
      <main className="min-h-screen">
        <ReaderLoader />
      </main>
    );
  }

  if (!sourceDocument) {
    return (
      <main className="min-h-screen">
        <ReaderError
          error={new Error(`Expected ${readerType.toUpperCase()} source data, received ${bootstrap.documentSource.document.type}.`)}
        />
      </main>
    );
  }

  if (initializationError) {
    return (
      <main className="min-h-screen">
        <ReaderError error={initializationError} onRetry={retryRenderer} />
      </main>
    );
  }

  if (!payload || adoption.adoptedAttemptKey !== attemptKey) {
    return (
      <main className="min-h-screen">
        <ReaderLoader />
      </main>
    );
  }

  return (
    <>
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
            onReady: handleReady,
            onError: handleError,
          })}
        </Fragment>
      </div>
      {!rendererReady || rendererError ? (
        <div className="fixed inset-0 z-50 min-h-screen">
          {rendererError
            ? <ReaderError error={rendererError} onRetry={retryRenderer} />
            : <ReaderLoader />}
        </div>
      ) : null}
    </>
  );
}
