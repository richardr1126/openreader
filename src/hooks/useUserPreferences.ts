'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getUserPreferences, putUserPreferences } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import { deriveQueryState } from '@/lib/client/query/query-state';
import type { SyncedPreferencesPatch } from '@/types/user-state';

export function useUserPreferences(sessionId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const key = queryKeys.preferences(sessionId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => getUserPreferences({ signal }), enabled });
  const queryState = deriveQueryState({
    hasData: enabled && query.data !== undefined,
    isFetching: !enabled || query.isFetching,
    isError: query.isError,
    error: query.error,
  });
  const mutation = useMutation({
    mutationFn: (patch: SyncedPreferencesPatch) => putUserPreferences(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Awaited<ReturnType<typeof getUserPreferences>>>(key);
      queryClient.setQueryData(key, {
        preferences: { ...(previous?.preferences ?? {}), ...patch },
        clientUpdatedAtMs: Date.now(),
        hasStoredPreferences: true,
      });
      return { previous };
    },
    onError: (_error, _patch, context) => queryClient.setQueryData(key, context?.previous),
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { query, queryState, mutation };
}
