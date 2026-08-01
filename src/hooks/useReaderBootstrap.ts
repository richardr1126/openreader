'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  getReaderBootstrap,
  subscribeReaderBootstrap,
} from '@/lib/client/api/reader-bootstrap';
import { ensureCachedDocument } from '@/lib/client/cache/documents';
import { putDocumentSettings } from '@/lib/client/api/documents';
import { putDocumentProgress } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import type { DocumentSettings } from '@/types/document-settings';
import type { ReaderBootstrapResult } from '@/types/reader-bootstrap';
import type { ReaderDocument } from '@/types/documents';
import type { DocumentProgressPayload } from '@/types/user-state';

export type ReaderDocumentSourceResult =
  | { status: 'idle' | 'pending' }
  | { status: 'ready'; document: ReaderDocument }
  | { status: 'error'; error: Error };

export function useReaderBootstrap(documentId: string | undefined) {
  const { data: session, isPending: sessionPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.readerBootstrap(sessionId, documentId ?? '');
  const queryClient = useQueryClient();
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProgress = useRef<DocumentProgressPayload | null>(null);
  const lastProgressTimestamp = useRef(0);
  const progressPersistenceEnabled = useRef(false);

  const query = useQuery({
    queryKey: key,
    // Bootstrap ensures durable server work. Development Strict Mode may
    // briefly remove every observer, but that must not abort the request that
    // creates/reconnects the operation or surface an ECONNRESET on the server.
    queryFn: () => getReaderBootstrap(documentId!),
    enabled: !sessionPending && Boolean(documentId),
    retry: false,
    gcTime: 0,
  });
  const settingsMutation = useMutation({
    mutationFn: (settings: DocumentSettings) => putDocumentSettings(documentId!, settings),
  });
  const progressMutation = useMutation({ mutationFn: putDocumentProgress });
  const mutateProgress = progressMutation.mutate;

  const result: ReaderBootstrapResult = !documentId
    ? { status: 'error', message: 'Document not found.', retryable: false }
    : query.error
      ? {
        status: 'error',
        message: query.error instanceof Error ? query.error.message : 'Failed to prepare reader.',
        retryable: true,
      }
      : query.data ?? { status: 'pending' };
  const sourceMetadata = result.status === 'ready' ? result.payload.document : null;
  const sourceQuery = useQuery({
    queryKey: queryKeys.readerDocumentSource(
      sessionId,
      sourceMetadata?.id ?? '',
      sourceMetadata?.contentVersion ?? sourceMetadata?.id ?? '',
    ),
    // Do not consume the observer-lifetime AbortSignal. React development
    // Strict Mode briefly unsubscribes and resubscribes; useful immutable
    // same-key work must be allowed to finish and populate the shared query.
    queryFn: () => ensureCachedDocument(sourceMetadata!),
    enabled: Boolean(sourceMetadata),
    retry: false,
    gcTime: 0,
  });

  const flushProgress = useCallback(() => {
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = null;
    const payload = pendingProgress.current;
    pendingProgress.current = null;
    if (payload) mutateProgress(payload);
  }, [mutateProgress]);

  const scheduleProgress = useCallback((
    payload: DocumentProgressPayload,
    debounceMs = 1_000,
  ) => {
    if (!progressPersistenceEnabled.current) return;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    const clientUpdatedAtMs = Math.max(Date.now(), lastProgressTimestamp.current + 1);
    lastProgressTimestamp.current = clientUpdatedAtMs;
    pendingProgress.current = { ...payload, clientUpdatedAtMs };
    progressTimer.current = setTimeout(flushProgress, debounceMs);
  }, [flushProgress]);

  const enableProgressPersistence = useCallback(() => {
    progressPersistenceEnabled.current = true;
  }, []);
  const disableProgressPersistence = useCallback(() => {
    progressPersistenceEnabled.current = false;
    flushProgress();
  }, [flushProgress]);
  const updateSettings = useCallback(async (settings: DocumentSettings) => {
    await settingsMutation.mutateAsync(settings);
    await query.refetch({ throwOnError: true });
  }, [query, settingsMutation]);
  const retry = useCallback(async () => {
    await query.refetch();
  }, [query]);
  const retryDocumentSource = useCallback(async () => {
    await sourceQuery.refetch();
  }, [sourceQuery]);

  useEffect(() => {
    progressPersistenceEnabled.current = false;
  }, [documentId]);
  useEffect(() => () => flushProgress(), [flushProgress]);
  useEffect(() => {
    if (!documentId || query.data?.status !== 'pending') return;
    return subscribeReaderBootstrap(documentId, (snapshot) => {
      queryClient.setQueryData<ReaderBootstrapResult>(
        queryKeys.readerBootstrap(sessionId, documentId),
        snapshot,
      );
    });
  }, [documentId, query.data?.status, queryClient, sessionId]);

  const documentSource: ReaderDocumentSourceResult = result.status !== 'ready'
    ? { status: 'idle' }
    : sourceQuery.error
      ? {
        status: 'error',
        error: sourceQuery.error instanceof Error
          ? sourceQuery.error
          : new Error('Failed to load document source.'),
      }
      : sourceQuery.data
        ? { status: 'ready', document: sourceQuery.data }
        : { status: 'pending' };

  return {
    result,
    documentSource,
    retry,
    retryDocumentSource,
    updateSettings,
    scheduleProgress,
    enableProgressPersistence,
    disableProgressPersistence,
  };
}
