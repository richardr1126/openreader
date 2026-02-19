'use client';

import { useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/client/dexie';
import type { HTMLDocument } from '@/types/documents';
import { sha256HexFromString } from '@/lib/client/sha256';

export function useHTMLDocuments() {
  const documents = useLiveQuery(
    () => db['html-documents'].toArray(),
    [],
    undefined,
  );

  const isLoading = documents === undefined;

  const addDocument = useCallback(async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const content = new TextDecoder().decode(bytes);
    const id = await sha256HexFromString(content);

    const newDoc: HTMLDocument = {
      id,
      type: 'html',
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      data: content,
    };

    await db['html-documents'].put(newDoc);
    return id;
  }, []);

  const removeDocument = useCallback(async (id: string): Promise<void> => {
    await db['html-documents'].delete(id);
  }, []);

  const clearDocuments = useCallback(async (): Promise<void> => {
    await db['html-documents'].clear();
  }, []);

  return {
    documents: documents ?? [],
    isLoading,
    addDocument,
    removeDocument,
    clearDocuments,
  };
}
