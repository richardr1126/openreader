'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClonedVoice } from '@openreader/tts/cloned-voices';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

/**
 * Display names for the user's personal `clone:` voices. Fetched only when a
 * label actually shows one; picker mutations update this entry through the
 * shared cloned-voices root key.
 */
export function useClonedVoiceNames(...voices: string[]): ReadonlyMap<string, string> {
  const { data: session } = useAuthSession();
  const sessionId = session?.user?.id ?? '';
  const library = useQuery<{ voices: ClonedVoice[] }>({
    queryKey: queryKeys.clonedVoicesRoot(sessionId),
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/tts/cloned-voices', { signal });
      if (!response.ok) throw new Error('Could not load your voices.');
      return response.json();
    },
    enabled: !!sessionId && voices.some((voice) => voice.startsWith('clone:')),
    staleTime: 60_000,
  });
  return useMemo(
    () => new Map((library.data?.voices ?? []).map((voice) => [voice.id, voice.name])),
    [library.data],
  );
}
