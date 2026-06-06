'use client';

import { useCallback, useEffect, useState } from 'react';

import { getDocumentSettings, putDocumentSettings } from '@/lib/client/api/documents';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@/types/document-settings';

export function useDocumentLanguage(documentId: string | undefined): {
  language: string;
  updateLanguage: (language: string) => Promise<void>;
} {
  const [settings, setSettings] = useState<DocumentSettings>(DEFAULT_DOCUMENT_SETTINGS);

  useEffect(() => {
    setSettings(DEFAULT_DOCUMENT_SETTINGS);
    if (!documentId) return;

    const controller = new AbortController();
    void getDocumentSettings(documentId, { signal: controller.signal })
      .then((response) => {
        setSettings(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, response.settings));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Failed to load document language, using automatic detection:', error);
      });

    return () => controller.abort();
  }, [documentId]);

  const updateLanguage = useCallback(async (language: string): Promise<void> => {
    if (!documentId) return;
    const next = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      ...settings,
      schemaVersion: 1,
      language,
    });
    setSettings(next);
    try {
      const response = await putDocumentSettings(documentId, next);
      setSettings(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, response.settings));
    } catch (error) {
      console.warn('Failed to persist document language:', error);
    }
  }, [documentId, settings]);

  return {
    language: settings.language ?? 'auto',
    updateLanguage,
  };
}
