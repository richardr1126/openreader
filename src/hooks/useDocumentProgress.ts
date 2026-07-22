'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocumentProgress, putDocumentProgress } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { DocumentProgressPayload, DocumentProgressRecord } from '@/types/user-state';

export function useDocumentProgress(documentId: string | undefined) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.progress(sessionId, documentId ?? '');
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<DocumentProgressPayload | null>(null);
  const lastTimestamp = useRef(0);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getDocumentProgress(documentId!, { signal }),
    enabled: !isPending && !!documentId,
  });
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: putDocumentProgress,
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DocumentProgressRecord | null>(key);
      const clientUpdatedAtMs = payload.clientUpdatedAtMs ?? Date.now();
      queryClient.setQueryData(key, {
        documentId: payload.documentId,
        readerType: payload.readerType,
        ...(payload.readerType === 'epub'
          ? { locator: payload.locator }
          : { location: payload.location }),
        progress: payload.progress ?? null,
        clientUpdatedAtMs,
        updatedAtMs: clientUpdatedAtMs,
      });
      return { previous, clientUpdatedAtMs };
    },
    onError: (_error, _payload, context) => {
      const current = queryClient.getQueryData<DocumentProgressRecord | null>(key);
      if (current?.clientUpdatedAtMs === context?.clientUpdatedAtMs) {
        queryClient.setQueryData(key, context?.previous);
      }
    },
    onSuccess: (data) => {
      const current = queryClient.getQueryData<DocumentProgressRecord | null>(key);
      if (!current || !data || data.clientUpdatedAtMs >= current.clientUpdatedAtMs) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: key }) === 1) {
        return queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  const mutateProgress = mutation.mutate;
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!pending.current) return;
    const payload = pending.current;
    pending.current = null;
    mutateProgress(payload);
  }, [mutateProgress]);
  const schedule = useCallback((payload: DocumentProgressPayload, debounceMs = 1000) => {
    if (timer.current) clearTimeout(timer.current);
    const now = Date.now();
    const clientUpdatedAtMs = Math.max(now, lastTimestamp.current + 1);
    lastTimestamp.current = clientUpdatedAtMs;
    pending.current = { ...payload, clientUpdatedAtMs };
    timer.current = setTimeout(flush, debounceMs);
  }, [flush]);
  useEffect(() => () => flush(), [flush]);
  return { query, mutation, schedule, flush };
}
