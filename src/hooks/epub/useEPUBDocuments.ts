'use client';

import { useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/client/dexie';
import type { EPUBDocument } from '@/types/documents';
import { sha256HexFromArrayBuffer } from '@/lib/client/sha256';

export function useEPUBDocuments() {
  const documents = useLiveQuery(
    () => db['epub-documents'].toArray(),
    [],
    undefined,
  );

  const isLoading = documents === undefined;

  const addDocument = useCallback(async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const id = await sha256HexFromArrayBuffer(arrayBuffer);

    console.log('Original file size:', file.size);
    console.log('ArrayBuffer size:', arrayBuffer.byteLength);

    const newDoc: EPUBDocument = {
      id,
      type: 'epub',
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      data: arrayBuffer,
    };

    await db['epub-documents'].put(newDoc);
    return id;
  }, []);

  const removeDocument = useCallback(async (id: string): Promise<void> => {
    await db['epub-documents'].delete(id);
  }, []);

  const clearDocuments = useCallback(async (): Promise<void> => {
    await db['epub-documents'].clear();
  }, []);

  return {
    documents: documents ?? [],
    isLoading,
    addDocument,
    removeDocument,
    clearDocuments,
  };
}
