'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BaseDocument } from '@/types/documents';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

async function fetchLibraryDocuments(signal?: AbortSignal): Promise<BaseDocument[]> {
  const res = await fetch('/api/documents/library?limit=10000', { signal });
  if (!res.ok) throw new Error('Failed to list library documents');
  const data = (await res.json()) as { documents?: BaseDocument[] };
  return data.documents || [];
}

export function useLibraryDocumentsQuery(enabled: boolean): {
  documents: BaseDocument[];
  isLoading: boolean;
  errorMessage: string | null;
  refetch: () => Promise<void>;
  prefetch: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const key = useMemo(
    () => queryKeys.libraryDocuments(session?.user?.id ?? 'no-session'),
    [session?.user?.id],
  );
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchLibraryDocuments(signal),
    enabled: enabled && !isSessionPending,
    staleTime: 60 * 1000,
  });

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const prefetch = useCallback(async () => {
    await queryClient.prefetchQuery({
      queryKey: key,
      queryFn: ({ signal }) => fetchLibraryDocuments(signal),
      staleTime: 60 * 1000,
    });
  }, [key, queryClient]);

  return {
    documents: query.data ?? [],
    isLoading: isSessionPending || (query.isPending && !query.data),
    errorMessage: query.error instanceof Error ? query.error.message : query.error ? 'Failed to list library documents' : null,
    refetch,
    prefetch,
  };
}
