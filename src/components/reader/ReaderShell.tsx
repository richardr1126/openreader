'use client';

import {
  Fragment,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import { useReaderBootstrap } from '@/hooks/useReaderBootstrap';
import type { ReaderPayload } from '@/types/reader-bootstrap';
import type { ReaderType } from '@/types/user-state';
import { ReaderError, ReaderLoader } from './ReaderLoader';

export type ReaderRendererProps<T extends ReaderType> = {
  payload: Extract<ReaderPayload, { readerType: T }>;
  bootstrap: ReturnType<typeof useReaderBootstrap>;
  rendererReady: boolean;
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
    disableProgressPersistence,
    enableProgressPersistence,
  } = bootstrap;
  const surfaceKey = result.status === 'ready'
    ? `${result.payload.documentId}:${result.payload.plan.planId}`
    : documentId ?? '';
  const [readySurfaceKey, setReadySurfaceKey] = useState<string | null>(null);
  const [rendererFailure, setRendererFailure] = useState<{
    surfaceKey: string;
    error: Error;
  } | null>(null);
  const [rendererAttempt, setRendererAttempt] = useState(0);
  const rendererReady = readySurfaceKey === surfaceKey;
  const rendererError = rendererFailure?.surfaceKey === surfaceKey
    ? rendererFailure.error
    : null;

  const handleReady = useCallback(() => {
    setReadySurfaceKey(surfaceKey);
    setRendererFailure(null);
    enableProgressPersistence();
  }, [enableProgressPersistence, surfaceKey]);

  const handleError = useCallback((error: Error) => {
    // The shell owns initial reveal only. Renderer mechanics after the first
    // usable surface must not restart bootstrap or hide an established reader.
    if (readySurfaceKey === surfaceKey) return;
    disableProgressPersistence();
    setRendererFailure({ surfaceKey, error });
  }, [disableProgressPersistence, readySurfaceKey, surfaceKey]);

  const retryRenderer = useCallback(() => {
    disableProgressPersistence();
    setReadySurfaceKey(null);
    setRendererFailure(null);
    setRendererAttempt((attempt) => attempt + 1);
  }, [disableProgressPersistence]);

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

  const payload = result.payload as Extract<ReaderPayload, { readerType: T }>;

  return (
    <>
      <div
        className={rendererReady ? undefined : 'pointer-events-none opacity-0'}
        aria-hidden={!rendererReady}
      >
        <Fragment key={`${surfaceKey}:${rendererAttempt}`}>
          {children({
            payload,
            bootstrap,
            rendererReady,
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
