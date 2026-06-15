'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getUserPreferences, putUserPreferences } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import { deriveQueryState } from '@/lib/client/query/query-state';
import type { SyncedPreferencesPatch } from '@/types/user-state';

const mutationTimestamps = new WeakMap<SyncedPreferencesPatch, number>();
const latestTimestampBySession = new Map<string, number>();

function nextMutationTimestamp(sessionId: string): number {
  const timestamp = Math.max(Date.now(), (latestTimestampBySession.get(sessionId) ?? 0) + 1);
  latestTimestampBySession.set(sessionId, timestamp);
  return timestamp;
}

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
    mutationKey: key,
    scope: { id: `preferences:${sessionId}` },
    mutationFn: (patch: SyncedPreferencesPatch) => putUserPreferences(patch, {
      clientUpdatedAtMs: mutationTimestamps.get(patch),
    }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Awaited<ReturnType<typeof getUserPreferences>>>(key);
      const clientUpdatedAtMs = nextMutationTimestamp(sessionId);
      mutationTimestamps.set(patch, clientUpdatedAtMs);
      queryClient.setQueryData(key, {
        preferences: { ...(previous?.preferences ?? {}), ...patch },
        clientUpdatedAtMs,
        hasStoredPreferences: true,
      });
      return { previous, clientUpdatedAtMs };
    },
    onError: (_error, _patch, context) => {
      const current = queryClient.getQueryData<Awaited<ReturnType<typeof getUserPreferences>>>(key);
      if (current?.clientUpdatedAtMs === context?.clientUpdatedAtMs) {
        queryClient.setQueryData(key, context?.previous);
      }
    },
    onSuccess: (data) => {
      const current = queryClient.getQueryData<Awaited<ReturnType<typeof getUserPreferences>>>(key);
      if (!current || data.clientUpdatedAtMs >= current.clientUpdatedAtMs) {
        queryClient.setQueryData(key, data);
        return;
      }
      queryClient.setQueryData(key, {
        ...data,
        preferences: { ...data.preferences, ...current.preferences },
        clientUpdatedAtMs: current.clientUpdatedAtMs,
        hasStoredPreferences: true,
      });
    },
    onSettled: (_data, _error, patch) => {
      mutationTimestamps.delete(patch);
      if (queryClient.isMutating({ mutationKey: key }) === 1) {
        return queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  return { query, queryState, mutation };
}
