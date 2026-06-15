'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocumentSettings, putDocumentSettings } from '@/lib/client/api/documents';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { DocumentSettings } from '@/types/document-settings';

export function useDocumentSettings(documentId: string | undefined) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.documentSettings(sessionId, documentId ?? '');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getDocumentSettings(documentId!, { signal }),
    enabled: !isPending && !!documentId,
  });
  const mutation = useMutation({
    mutationFn: (settings: DocumentSettings) => putDocumentSettings(documentId!, settings),
    onMutate: async (settings) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, { settings, clientUpdatedAtMs: Date.now(), hasStoredSettings: true });
      return { previous };
    },
    onError: (_error, _settings, context) => queryClient.setQueryData(key, context?.previous),
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { query, mutation };
}
