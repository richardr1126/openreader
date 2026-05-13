'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TtsProviderId } from '@/lib/shared/tts-provider-catalog';

export interface SharedProviderEntry {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  defaultModel: string | null;
  defaultInstructions: string | null;
}

export const SHARED_PROVIDERS_QUERY_KEY = ['tts-shared-providers'] as const;

async function fetchSharedProviders(): Promise<SharedProviderEntry[]> {
  try {
    const res = await fetch('/api/tts/shared-providers', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = (await res.json()) as { providers?: SharedProviderEntry[] };
    return data.providers ?? [];
  } catch {
    return [];
  }
}

export function useSharedProviders(): {
  providers: SharedProviderEntry[];
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { data = [], isPending, refetch } = useQuery({
    queryKey: SHARED_PROVIDERS_QUERY_KEY,
    queryFn: fetchSharedProviders,
    staleTime: 5 * 60 * 1000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SHARED_PROVIDERS_QUERY_KEY });
    await refetch();
  }, [queryClient, refetch]);

  return { providers: data, isLoading: isPending, refresh };
}
