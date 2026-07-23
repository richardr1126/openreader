'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getReaderBootstrap } from '@/lib/client/api/reader-bootstrap';
import { putDocumentSettings } from '@/lib/client/api/documents';
import { putDocumentProgress } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import type { DocumentSettings } from '@/types/document-settings';
import type { ReaderBootstrapResult } from '@/types/reader-bootstrap';
import type { DocumentProgressPayload } from '@/types/user-state';

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
    queryFn: ({ signal }) => getReaderBootstrap(documentId!, { signal }),
    enabled: !sessionPending && Boolean(documentId),
    retry: false,
    gcTime: 0,
    refetchInterval: (current) => (
      current.state.data?.status === 'pending' ? 1_000 : false
    ),
  });
  const settingsMutation = useMutation({
    mutationFn: (settings: DocumentSettings) => putDocumentSettings(documentId!, settings),
    onSuccess: (response) => {
      queryClient.setQueryData<ReaderBootstrapResult>(key, (current) => (
        current?.status === 'ready'
          ? {
            ...current,
            payload: { ...current.payload, settings: response.settings },
          }
          : current
      ));
    },
  });
  const progressMutation = useMutation({ mutationFn: putDocumentProgress });
  const mutateProgress = progressMutation.mutate;

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
  const updateSettings = useCallback(
    (settings: DocumentSettings) => settingsMutation.mutateAsync(settings),
    [settingsMutation],
  );
  const retry = useCallback(async () => {
    await query.refetch();
  }, [query]);

  useEffect(() => {
    progressPersistenceEnabled.current = false;
  }, [documentId]);
  useEffect(() => () => flushProgress(), [flushProgress]);

  const result: ReaderBootstrapResult = !documentId
    ? { status: 'error', message: 'Document not found.', retryable: false }
    : query.error
      ? {
        status: 'error',
        message: query.error instanceof Error ? query.error.message : 'Failed to prepare reader.',
        retryable: true,
      }
      : query.data ?? { status: 'pending' };

  return {
    result,
    retry,
    updateSettings,
    scheduleProgress,
    enableProgressPersistence,
    disableProgressPersistence,
  };
}
