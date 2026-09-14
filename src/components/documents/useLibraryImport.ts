'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocuments } from '@/contexts/DocumentContext';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { useLibraryDocumentsQuery } from '@/hooks/useLibraryDocumentsQuery';
import { mimeTypeForDoc } from '@/lib/client/api/documents';
import type { BaseDocument } from '@/types/documents';

export function useLibraryImport(folderId?: string) {
  const { uploadDocuments } = useDocuments();
  const [isSelectionOpen, setIsSelectionOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const { progress, setProgress, estimatedTimeRemaining } = useTimeEstimation();
  const {
    documents,
    isLoading,
    errorMessage,
    prefetch,
  } = useLibraryDocumentsQuery(isSelectionOpen);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setShowProgress(false);
    setProgress(0);
    setIsImporting(false);
    setStatusMessage('');
  }, [setProgress]);

  useEffect(() => cancel, [cancel]);

  const openSelection = useCallback(() => {
    void prefetch();
    setIsSelectionOpen(true);
  }, [prefetch]);

  const closeSelection = useCallback(() => {
    if (!isImporting) setIsSelectionOpen(false);
  }, [isImporting]);

  const importDocuments = useCallback(async (selectedFiles: BaseDocument[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsSelectionOpen(false);

    try {
      setShowProgress(true);
      setProgress(0);
      setIsImporting(true);
      let importedCount = 0;

      for (let index = 0; index < selectedFiles.length; index += 1) {
        if (controller.signal.aborted) break;
        const document = selectedFiles[index];
        setStatusMessage(`Importing ${index + 1}/${selectedFiles.length}: ${document.name}`);
        setProgress((index / Math.max(1, selectedFiles.length)) * 100);

        const contentResponse = await fetch(
          `/api/local-library/content?id=${encodeURIComponent(document.id)}`,
          { signal: controller.signal },
        );
        if (!contentResponse.ok) {
          console.warn(`Failed to download library document: ${document.name}`);
          continue;
        }

        const bytes = await contentResponse.arrayBuffer();
        const file = new File([bytes], document.name, {
          type: mimeTypeForDoc(document),
          lastModified: document.lastModified,
        });
        await uploadDocuments([file], { signal: controller.signal, folderId });
        importedCount += 1;
        setProgress(((index + 1) / Math.max(1, selectedFiles.length)) * 100);
      }

      if (!controller.signal.aborted) {
        if (importedCount === 0) throw new Error('No server-library documents could be copied');
        setStatusMessage('Import complete');
      }
    } catch (error) {
      if (controller.signal.aborted) {
        console.log('library import cancelled');
        setStatusMessage('Operation cancelled');
      } else {
        console.error('library import failed:', error);
        setStatusMessage('Import failed. Please try again.');
      }
    } finally {
      abortRef.current = null;
      setIsImporting(false);
      setShowProgress(false);
      setProgress(0);
      setStatusMessage('');
    }
  }, [folderId, setProgress, uploadDocuments]);

  return {
    documents,
    errorMessage,
    estimatedTimeRemaining,
    importDocuments,
    isImporting,
    isLoading,
    isSelectionOpen,
    openSelection,
    closeSelection,
    progress,
    showProgress,
    statusMessage,
    cancel,
  };
}
