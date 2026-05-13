'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BaseDocument } from '@/types/documents';
import { listDocuments, uploadDocuments, deleteDocuments } from '@/lib/client/api/documents';
import { putCachedEpub, putCachedHtml, putCachedPdf, evictCachedEpub, evictCachedHtml, evictCachedPdf } from '@/lib/client/cache/documents';
import { useAuthSession } from '@/hooks/useAuthSession';

interface DocumentContextType {
  pdfDocs: Array<BaseDocument & { type: 'pdf' }>;
  addPDFDocument: (file: File) => Promise<string>;
  removePDFDocument: (id: string) => Promise<void>;
  isPDFLoading: boolean;

  epubDocs: Array<BaseDocument & { type: 'epub' }>;
  addEPUBDocument: (file: File) => Promise<string>;
  removeEPUBDocument: (id: string) => Promise<void>;
  isEPUBLoading: boolean;

  htmlDocs: Array<BaseDocument & { type: 'html' }>;
  addHTMLDocument: (file: File) => Promise<string>;
  removeHTMLDocument: (id: string) => Promise<void>;
  isHTMLLoading: boolean;

  refreshDocuments: () => Promise<void>;
}

const DocumentContext = createContext<DocumentContextType | undefined>(undefined);
const DOCUMENTS_QUERY_KEY = 'documents';

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

  const cacheUploaded = useCallback(async (stored: BaseDocument, file: File) => {
    try {
      if (stored.type === 'pdf') {
        await putCachedPdf(stored, await file.arrayBuffer());
      } else if (stored.type === 'epub') {
        await putCachedEpub(stored, await file.arrayBuffer());
      } else if (stored.type === 'html') {
        const buf = await file.arrayBuffer();
        const decoded = new TextDecoder().decode(new Uint8Array(buf));
        await putCachedHtml(stored, decoded);
      }
    } catch (err) {
      // Cache failures should not block uploads.
      console.warn('Failed to cache uploaded document:', stored.id, err);
    }
  }, []);

  const addDocument = useCallback(async (file: File): Promise<string> => {
    const [stored] = await uploadDocuments([file]);
    if (!stored) throw new Error('Upload succeeded but returned no document');
    await cacheUploaded(stored, file);
    const isSupported = stored.type === 'pdf' || stored.type === 'epub' || stored.type === 'html';
    if (!isSupported) return stored.id;
    const supportedStored = stored as BaseDocument & { type: 'pdf' | 'epub' | 'html' };
    queryClient.setQueryData<Array<BaseDocument & { type: 'pdf' | 'epub' | 'html' }>>(documentsQueryKey, (prev = []) => {
      const next = prev.filter((d) => d.id !== supportedStored.id);
      return [supportedStored, ...next];
    });
    return stored.id;
  }, [cacheUploaded, queryClient, documentsQueryKey]);

  const addPDFDocument = useCallback(async (file: File) => addDocument(file), [addDocument]);
  const addEPUBDocument = useCallback(async (file: File) => addDocument(file), [addDocument]);
  const addHTMLDocument = useCallback(async (file: File) => addDocument(file), [addDocument]);

  const removeById = useCallback(async (id: string) => {
    await deleteDocuments({ ids: [id] });
    await Promise.allSettled([evictCachedPdf(id), evictCachedEpub(id), evictCachedHtml(id)]);
    queryClient.setQueryData<Array<BaseDocument & { type: 'pdf' | 'epub' | 'html' }>>(documentsQueryKey, (prev = []) =>
      prev.filter((d) => d.id !== id),
    );
  }, [queryClient, documentsQueryKey]);

  const removePDFDocument = useCallback(async (id: string) => removeById(id), [removeById]);
  const removeEPUBDocument = useCallback(async (id: string) => removeById(id), [removeById]);
  const removeHTMLDocument = useCallback(async (id: string) => removeById(id), [removeById]);

  return (
    <DocumentContext.Provider value={{
      pdfDocs: docsByType.pdfDocs,
      addPDFDocument,
      removePDFDocument,
      isPDFLoading: isLoading,
      epubDocs: docsByType.epubDocs,
      addEPUBDocument,
      removeEPUBDocument,
      isEPUBLoading: isLoading,
      htmlDocs: docsByType.htmlDocs,
      addHTMLDocument,
      removeHTMLDocument,
      isHTMLLoading: isLoading,
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
