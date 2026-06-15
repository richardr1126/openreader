'use client';

import { useCallback } from 'react';

import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@/types/document-settings';
import { useDocumentSettings } from '@/hooks/useDocumentSettings';

export function useDocumentLanguage(documentId: string | undefined): {
  language: string;
  updateLanguage: (language: string) => Promise<void>;
} {
  const { query, mutation } = useDocumentSettings(documentId);
  const settings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, query.data?.settings);

  const updateLanguage = useCallback(async (language: string): Promise<void> => {
    if (!documentId) return;
    const next: DocumentSettings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      ...settings,
      schemaVersion: 1,
      language,
    });
    try {
      await mutation.mutateAsync(next);
    } catch (error) {
      console.warn('Failed to persist document language:', error);
    }
  }, [documentId, mutation, settings]);

  return {
    language: settings.language ?? 'auto',
    updateLanguage,
  };
}
