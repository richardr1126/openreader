'use client';

import { useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/client/dexie';
import type { PDFDocument } from '@/types/documents';
import { sha256HexFromArrayBuffer } from '@/lib/client/sha256';

export function usePDFDocuments() {
  const documents = useLiveQuery(
    () => db['pdf-documents'].toArray(),
    [],
    undefined,
  );

  const isLoading = documents === undefined;

  const addDocument = useCallback(async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const id = await sha256HexFromArrayBuffer(arrayBuffer);

    const newDoc: PDFDocument = {
      id,
      type: 'pdf',
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      data: arrayBuffer,
    };

    await db['pdf-documents'].put(newDoc);
    return id;
  }, []);

  const removeDocument = useCallback(async (id: string): Promise<void> => {
    await db['pdf-documents'].delete(id);
  }, []);

  const clearDocuments = useCallback(async (): Promise<void> => {
    await db['pdf-documents'].clear();
  }, []);

  return {
    documents: documents ?? [],
    isLoading,
    addDocument,
    removeDocument,
    clearDocuments,
  };
}
