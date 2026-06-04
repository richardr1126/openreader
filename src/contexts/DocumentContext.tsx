'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BaseDocument } from '@/types/documents';
import {
  deleteDocuments as deleteServerDocuments,
  listDocuments,
  uploadDocuments as uploadServerDocuments,
} from '@/lib/client/api/documents';
import { cacheStoredDocumentFromBytes, evictCachedDocument } from '@/lib/client/cache/documents';
import { useAuthSession } from '@/hooks/useAuthSession';

interface DocumentContextType {
  pdfDocs: Array<BaseDocument & { type: 'pdf' }>;
  isPDFLoading: boolean;

  epubDocs: Array<BaseDocument & { type: 'epub' }>;
  isEPUBLoading: boolean;

  htmlDocs: Array<BaseDocument & { type: 'html' }>;
  isHTMLLoading: boolean;

  uploadDocuments: (files: File[]) => Promise<BaseDocument[]>;
  deleteDocument: (id: string) => Promise<void>;
  refreshDocuments: () => Promise<void>;
}

const DocumentContext = createContext<DocumentContextType | undefined>(undefined);
const DOCUMENTS_QUERY_KEY = 'documents';

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
  const documentsQueryKey = useMemo(() => [DOCUMENTS_QUERY_KEY, sessionKey] as const, [sessionKey]);

  const loadDocuments = useCallback(async () => {
    try {
      const serverDocs = await listDocuments();
      return serverDocs.filter((d): d is BaseDocument & { type: 'pdf' | 'epub' | 'html' } =>
        d.type === 'pdf' || d.type === 'epub' || d.type === 'html',
      );
    } catch (err) {
      console.error('Failed to load documents from server:', err);
      return [];
    }
  }, []);

  const { data: docs = [], isPending, refetch } = useQuery({
    queryKey: documentsQueryKey,
    queryFn: loadDocuments,
    enabled: !isSessionPending,
  });

  const isLoading = isSessionPending || (isPending && docs.length === 0);

  const refreshDocuments = useCallback(async () => {
    if (isSessionPending) return;
    await queryClient.invalidateQueries({ queryKey: documentsQueryKey });
    await refetch();
  }, [isSessionPending, queryClient, documentsQueryKey, refetch]);

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

  const uploadDocuments = useCallback(async (files: File[]): Promise<BaseDocument[]> => {
    if (files.length === 0) return [];

    const stored = await uploadServerDocuments(files);
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

    queryClient.setQueryData<SupportedDocument[]>(documentsQueryKey, (previous) =>
      mergeStoredDocuments(previous, stored),
    );

    return stored;
  }, [documentsQueryKey, queryClient]);

  const deleteDocument = useCallback(async (id: string) => {
    await deleteServerDocuments({ ids: [id] });
    await evictCachedDocument(id);
    queryClient.setQueryData<SupportedDocument[]>(documentsQueryKey, (previous = []) =>
      previous.filter((document) => document.id !== id),
    );
  }, [documentsQueryKey, queryClient]);

  return (
    <DocumentContext.Provider value={{
      pdfDocs: docsByType.pdfDocs,
      isPDFLoading: isLoading,
      epubDocs: docsByType.epubDocs,
      isEPUBLoading: isLoading,
      htmlDocs: docsByType.htmlDocs,
      isHTMLLoading: isLoading,
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
