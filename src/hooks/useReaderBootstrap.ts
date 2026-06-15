'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDocumentMetadata } from '@/hooks/useDocumentMetadata';
import { useDocumentProgress } from '@/hooks/useDocumentProgress';
import { useDocumentSettings } from '@/hooks/useDocumentSettings';
import { resolveReaderBootstrapPhase } from '@/lib/client/reader-bootstrap';
import { parseReaderInitialPosition } from '@/lib/client/reader-progress';
import type { DocumentType } from '@/types/documents';
import type { DocumentSettings } from '@/types/document-settings';
import type { DocumentProgressPayload } from '@/types/user-state';
import { useConfig } from '@/contexts/ConfigContext';

export function useReaderBootstrap(documentId: string | undefined, expectedType: DocumentType) {
  const metadata = useDocumentMetadata(documentId);
  const settings = useDocumentSettings(documentId);
  const progress = useDocumentProgress(documentId);
  const scheduleDocumentProgress = progress.schedule;
  const flushDocumentProgress = progress.flush;
  const { preferencesError, preferencesReady } = useConfig();
  const markedOpenedDocumentRef = useRef<string | null>(null);
  const progressPersistenceEnabledRef = useRef(false);
  const markOpened = metadata.openedMutation.mutate;

  const phase = resolveReaderBootstrapPhase({
    documentId,
    expectedType,
    metadataType: metadata.query.data?.type,
    preferencesReady,
    preferencesError: !!preferencesError,
    metadata: metadata.query,
    settings: settings.query,
    progress: progress.query,
  });

  useEffect(() => {
    if (phase !== 'ready' || !documentId || markedOpenedDocumentRef.current === documentId) return;
    markedOpenedDocumentRef.current = documentId;
    markOpened();
  }, [documentId, markOpened, phase]);

  const error = useMemo(() => {
    if (!documentId) return new Error('Document not found');
    if (preferencesError) return preferencesError;
    if (metadata.query.error) return metadata.query.error;
    if (settings.query.error) return settings.query.error;
    if (progress.query.error) return progress.query.error;
    if (metadata.query.isSuccess && !metadata.query.data) return new Error('Document not found');
    if (metadata.query.data && metadata.query.data.type !== expectedType) {
      return new Error(`Expected a ${expectedType} document, received ${metadata.query.data.type}`);
    }
    return null;
  }, [
    documentId,
    expectedType,
    metadata.query.data,
    metadata.query.error,
    metadata.query.isSuccess,
    progress.query.error,
    preferencesError,
    settings.query.error,
  ]);
  const initialPosition = useMemo(
    () => parseReaderInitialPosition(expectedType, progress.query.data?.location),
    [expectedType, progress.query.data?.location],
  );
  const mutateSettings = settings.mutation.mutateAsync;
  const updateSettings = useCallback(
    (nextSettings: DocumentSettings) => mutateSettings(nextSettings),
    [mutateSettings],
  );
  const scheduleProgress = useCallback((
    payload: DocumentProgressPayload,
    debounceMs?: number,
  ) => {
    if (!progressPersistenceEnabledRef.current) return;
    scheduleDocumentProgress(payload, debounceMs);
  }, [scheduleDocumentProgress]);
  const enableProgressPersistence = useCallback(() => {
    progressPersistenceEnabledRef.current = true;
  }, []);
  const disableProgressPersistence = useCallback(() => {
    progressPersistenceEnabledRef.current = false;
    flushDocumentProgress();
  }, [flushDocumentProgress]);

  useEffect(() => {
    progressPersistenceEnabledRef.current = false;
  }, [documentId]);

  return {
    phase,
    error,
    document: metadata.query.data ?? null,
    settings: settings.query.data?.settings ?? null,
    progress: progress.query.data ?? null,
    initialPosition,
    scheduleProgress,
    enableProgressPersistence,
    disableProgressPersistence,
    updateSettings,
    preferencesReady,
    queries: {
      metadata: metadata.query,
      settings: settings.query,
      progress: progress.query,
    },
  };
}
