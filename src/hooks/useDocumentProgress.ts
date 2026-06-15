'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocumentProgress, putDocumentProgress } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { DocumentProgressRecord, ReaderType } from '@/types/user-state';

export function useDocumentProgress(documentId: string | undefined) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.progress(sessionId, documentId ?? '');
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getDocumentProgress(documentId!, { signal }),
    enabled: !isPending && !!documentId,
  });
  const mutation = useMutation({
    mutationFn: putDocumentProgress,
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DocumentProgressRecord | null>(key);
      queryClient.setQueryData(key, {
        documentId: payload.documentId,
        readerType: payload.readerType,
        location: payload.location,
        progress: payload.progress ?? null,
        clientUpdatedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      return { previous };
    },
    onError: (_error, _payload, context) => queryClient.setQueryData(key, context?.previous),
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const mutateProgress = mutation.mutate;
  const schedule = useCallback((payload: {
    documentId: string;
    readerType: ReaderType;
    location: string;
    progress?: number | null;
  }, debounceMs = 1000) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => mutateProgress(payload), debounceMs);
  }, [mutateProgress]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { query, mutation, schedule };
}
