'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BaseDocument } from '@/types/documents';
import {
  deleteDocuments as deleteServerDocuments,
  listDocuments,
  uploadDocuments as uploadServerDocuments,
} from '@/lib/client/api/documents';
import { cacheStoredDocumentFromBytes, evictCachedDocument } from '@/lib/client/cache/documents';
import { useAuthSession } from '@/hooks/useAuthSession';
import { queryKeys } from '@/lib/client/query-keys';
import { deriveQueryState, type DerivedQueryState } from '@/lib/client/query/query-state';

interface DocumentContextType {
  pdfDocs: Array<BaseDocument & { type: 'pdf' }>;
  epubDocs: Array<BaseDocument & { type: 'epub' }>;
  htmlDocs: Array<BaseDocument & { type: 'html' }>;
  queryState: DerivedQueryState;
  uploadDocuments: (files: File[]) => Promise<BaseDocument[]>;
  deleteDocument: (id: string) => Promise<void>;
  refreshDocuments: () => Promise<void>;
}

const DocumentContext = createContext<DocumentContextType | undefined>(undefined);
type SupportedDocument = BaseDocument & { type: 'pdf' | 'epub' | 'html' };

function mergeStoredDocuments(
  previous: SupportedDocument[] | undefined,
  uploaded: BaseDocument[],
): SupportedDocument[] {
  const next = [...(previous ?? [])];

  for (let index = uploaded.length - 1; index >= 0; index -= 1) {
    const stored = uploaded[index];
    if (stored.type !== 'pdf' && stored.type !== 'epub' && stored.type !== 'html') {
      continue;
    }
    const supportedStored = stored as SupportedDocument;
    const withoutExisting = next.filter((document) => document.id !== supportedStored.id);
    next.splice(0, next.length, supportedStored, ...withoutExisting);
  }

  return next;
}

export function DocumentProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: sessionData, isPending: isSessionPending } = useAuthSession();
  const sessionKey = sessionData?.user?.id ?? 'no-session';
  const documentsQueryKey = useMemo(() => queryKeys.documents(sessionKey), [sessionKey]);

  const loadDocuments = useCallback(async () => {
    const serverDocs = await listDocuments();
    return serverDocs.filter((d): d is BaseDocument & { type: 'pdf' | 'epub' | 'html' } =>
      d.type === 'pdf' || d.type === 'epub' || d.type === 'html',
    );
  }, []);

  const documentsQuery = useQuery({
    queryKey: documentsQueryKey,
    queryFn: loadDocuments,
    enabled: !isSessionPending,
  });
  const docs = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);
  const refetchDocuments = documentsQuery.refetch;
  const queryState = deriveQueryState({
    hasData: !isSessionPending && documentsQuery.data !== undefined,
    isFetching: isSessionPending || documentsQuery.isFetching,
    isError: documentsQuery.isError,
    error: documentsQuery.error,
  });

  const refreshDocuments = useCallback(async () => {
    if (isSessionPending) return;
    await queryClient.invalidateQueries({ queryKey: documentsQueryKey });
    await refetchDocuments();
  }, [isSessionPending, queryClient, documentsQueryKey, refetchDocuments]);

  useEffect(() => {
    const handler = () => {
      refreshDocuments().catch((err) => {
        console.error('Failed to refresh documents after change event:', err);
      });
    };

    window.addEventListener('openreader:documentsChanged', handler as EventListener);
    return () => {
      window.removeEventListener('openreader:documentsChanged', handler as EventListener);
    };
  }, [refreshDocuments]);

  const docsByType = useMemo(() => {
    const pdfDocs = docs.filter((d) => d.type === 'pdf') as Array<BaseDocument & { type: 'pdf' }>;
    const epubDocs = docs.filter((d) => d.type === 'epub') as Array<BaseDocument & { type: 'epub' }>;
    const htmlDocs = docs.filter((d) => d.type === 'html') as Array<BaseDocument & { type: 'html' }>;
    return { pdfDocs, epubDocs, htmlDocs };
  }, [docs]);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadServerDocuments(files),
    onSuccess: (stored) => {
      queryClient.setQueryData<SupportedDocument[]>(documentsQueryKey, (previous) =>
        mergeStoredDocuments(previous, stored),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsQueryKey }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteServerDocuments({ ids: [id] }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: documentsQueryKey });
      const previous = queryClient.getQueryData<SupportedDocument[]>(documentsQueryKey);
      queryClient.setQueryData<SupportedDocument[]>(documentsQueryKey, (rows = []) => rows.filter((doc) => doc.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => queryClient.setQueryData(documentsQueryKey, context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsQueryKey }),
  });

  const uploadDocuments = useCallback(async (files: File[]): Promise<BaseDocument[]> => {
    if (files.length === 0) return [];

    const stored = await uploadMutation.mutateAsync(files);
    await Promise.allSettled(
      stored.map(async (document, index) => {
        const file = files[index];
        if (!file) return;
        const sourceType = file.name
          ? (
            file.name.toLowerCase().endsWith('.pdf')
              ? 'pdf'
              : file.name.toLowerCase().endsWith('.epub')
                ? 'epub'
                : file.name.toLowerCase().endsWith('.docx')
                  ? 'docx'
                  : 'html'
          )
          : (
            file.type === 'application/pdf'
              ? 'pdf'
              : file.type === 'application/epub+zip'
                ? 'epub'
                : file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                  ? 'docx'
                  : 'html'
          );
        if (document.type !== sourceType) return;
        await cacheStoredDocumentFromBytes(document, await file.arrayBuffer());
      }),
    );

    return stored;
  }, [uploadMutation]);

  const deleteDocument = useCallback(async (id: string) => {
    await deleteMutation.mutateAsync(id);
    await evictCachedDocument(id);
  }, [deleteMutation]);

  return (
    <DocumentContext.Provider value={{
      pdfDocs: docsByType.pdfDocs,
      epubDocs: docsByType.epubDocs,
      htmlDocs: docsByType.htmlDocs,
      queryState,
      uploadDocuments,
      deleteDocument,
      refreshDocuments,

    }}>
      {children}
    </DocumentContext.Provider>
  );
}

export function useDocuments() {
  const context = useContext(DocumentContext);
  if (context === undefined) {
    throw new Error('useDocuments must be used within a DocumentProvider');
  }
  return context;
}
