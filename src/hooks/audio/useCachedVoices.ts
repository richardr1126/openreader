'use client';

import { useQuery } from '@tanstack/react-query';
import { getCachedVoices } from '@/lib/client/api/tts';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

/** The voices a document has cached audio for, fetched fresh each time a panel opens. */
export function useCachedVoices(documentId: string, enabled: boolean) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const query = useQuery({
    queryKey: queryKeys.cachedVoices(session?.user?.id ?? 'no-session', documentId),
    queryFn: ({ signal }) => getCachedVoices(documentId, signal),
    enabled: enabled && Boolean(documentId) && !isSessionPending,
    staleTime: 0,
    // A worker restart is brief; keep trying rather than show no cached voices.
    retry: 4,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });
  return query.data ?? [];
}
