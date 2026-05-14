'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BaseDocument } from '@/types/documents';

export const LIBRARY_DOCUMENTS_QUERY_KEY = ['documents-library', 10000] as const;

async function fetchLibraryDocuments(): Promise<BaseDocument[]> {
  const res = await fetch('/api/documents/library?limit=10000');
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
  const query = useQuery({
    queryKey: LIBRARY_DOCUMENTS_QUERY_KEY,
    queryFn: fetchLibraryDocuments,
    enabled,
    staleTime: 60 * 1000,
  });

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const prefetch = useCallback(async () => {
    await queryClient.prefetchQuery({
      queryKey: LIBRARY_DOCUMENTS_QUERY_KEY,
      queryFn: fetchLibraryDocuments,
      staleTime: 60 * 1000,
    });
  }, [queryClient]);

  return {
    documents: query.data ?? [],
    isLoading: query.isPending && !query.data,
    errorMessage: query.error instanceof Error ? query.error.message : query.error ? 'Failed to list library documents' : null,
    refetch,
    prefetch,
  };
}
