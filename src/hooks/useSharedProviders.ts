'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TtsProviderId } from '@openreader/tts/provider-catalog';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

export interface SharedProviderEntry {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  defaultModel: string | null;
  defaultInstructions: string | null;
}

async function fetchSharedProviders(signal?: AbortSignal): Promise<SharedProviderEntry[]> {
  const res = await fetch('/api/tts/shared-providers', { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`Failed to load shared providers (${res.status})`);
  const data = (await res.json()) as { providers?: SharedProviderEntry[] };
  return data.providers ?? [];
}

export function useSharedProviders(): {
  providers: SharedProviderEntry[];
  isLoading: boolean;
  errorMessage: string | null;
  refresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const key = useMemo(
    () => queryKeys.sharedProviders(session?.user?.id ?? 'no-session'),
    [session?.user?.id],
  );
  const { data = [], error, isPending, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchSharedProviders(signal),
    enabled: !isSessionPending,
    staleTime: 5 * 60 * 1000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await refetch();
  }, [key, queryClient, refetch]);
  useEffect(() => {
    if (error) console.error('Failed to load shared providers:', error);
  }, [error]);

  return {
    providers: data,
    isLoading: isSessionPending || isPending,
    errorMessage: error instanceof Error ? error.message : error ? 'Failed to load shared providers' : null,
    refresh,
  };
}
