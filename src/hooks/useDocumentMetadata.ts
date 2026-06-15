'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocumentMetadata, markDocumentOpened } from '@/lib/client/api/documents';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { BaseDocument } from '@/types/documents';

export function useDocumentMetadata(documentId: string | undefined) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const documentKey = queryKeys.document(sessionId, documentId ?? '');
  const documentsKey = queryKeys.documents(sessionId);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: documentKey,
    queryFn: ({ signal }) => getDocumentMetadata(documentId!, { signal }),
    enabled: !isPending && !!documentId,
  });

  const openedMutation = useMutation({
    mutationFn: () => markDocumentOpened(documentId!),
    onSuccess: ({ recentlyOpenedAt }) => {
      queryClient.setQueryData<BaseDocument | null>(documentKey, (document) => (
        document ? { ...document, recentlyOpenedAt } : document
      ));
      queryClient.setQueryData<BaseDocument[]>(documentsKey, (documents) => (
        documents?.map((document) => (
          document.id === documentId ? { ...document, recentlyOpenedAt } : document
        ))
      ));
    },
  });

  return { query, openedMutation };
}
