'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDocuments } from '@/contexts/DocumentContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useFolders } from '@/hooks/useFolders';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import type { PreferencesResponse } from '@/lib/client/api/user-state';
import { queryKeys } from '@/lib/client/query-keys';
import type { DocumentListDocument } from '@/types/documents';
import type { UploadBatchState } from '@/components/documents/DocumentUploader';
import { useDocumentSelection } from './dnd/DocumentSelectionContext';
import type { DocumentDragItem } from './dnd/dndTypes';
import { documentIdentityKey } from './dnd/dndTypes';
import { useIsNarrow } from './window/FinderWindow';
import {
  deriveDocumentListModel,
  suggestFolderName,
} from './document-list-model';
import {
  normalizeDocumentListState,
  serializeDocumentListState,
  type NormalizedDocumentListState,
} from './document-list-preferences';

type DocumentToDelete = {
  id: string;
  name: string;
  type: DocumentListDocument['type'];
};

type PendingMerge = {
  sources: DocumentListDocument[];
  target: DocumentListDocument;
};

export function useDocumentListController() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeUploadBatches, setActiveUploadBatches] = useState<Record<string, UploadBatchState>>({});
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<DocumentToDelete | null>(null);
  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [manualFolderPrompt, setManualFolderPrompt] = useState(false);
  const [clearFoldersPrompt, setClearFoldersPrompt] = useState(false);
  const preferenceWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isNarrow = useIsNarrow();
  const selection = useDocumentSelection();
  const queryClient = useQueryClient();
  const {
    pdfDocs,
    epubDocs,
    htmlDocs,
    queryState: documentsQueryState,
    deleteDocument,
    refreshDocuments,
  } = useDocuments();
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const { query: preferencesQuery, mutation: preferencesMutation } = useUserPreferences(
    sessionId,
    !isSessionPending,
  );
  const folderState = useFolders();
  const preferencesKey = queryKeys.preferences(sessionId);
  const persistPreferences = preferencesMutation.mutate;

  const listState = useMemo(
    () => normalizeDocumentListState(preferencesQuery.data?.preferences.documentListState),
    [preferencesQuery.data?.preferences.documentListState],
  );

  const persistLatestListState = useCallback(() => {
    const latest = queryClient.getQueryData<PreferencesResponse>(preferencesKey);
    persistPreferences({
      documentListState: serializeDocumentListState(
        normalizeDocumentListState(latest?.preferences?.documentListState),
      ),
    });
  }, [persistPreferences, preferencesKey, queryClient]);

  const updateListState = useCallback((
    patch: Partial<NormalizedDocumentListState>,
    persistImmediately = false,
  ) => {
    queryClient.setQueryData<PreferencesResponse>(preferencesKey, (previous) => ({
      preferences: {
        ...(previous?.preferences ?? {}),
        documentListState: serializeDocumentListState({
          ...normalizeDocumentListState(previous?.preferences?.documentListState),
          ...patch,
        }),
      },
      clientUpdatedAtMs: Date.now(),
      hasStoredPreferences: true,
    }));
    if (preferenceWriteTimer.current) clearTimeout(preferenceWriteTimer.current);
    if (persistImmediately) {
      preferenceWriteTimer.current = null;
      persistLatestListState();
      return;
    }
    preferenceWriteTimer.current = setTimeout(() => {
      preferenceWriteTimer.current = null;
      persistLatestListState();
    }, 250);
  }, [persistLatestListState, preferencesKey, queryClient]);

  useEffect(() => () => {
    if (!preferenceWriteTimer.current) return;
    clearTimeout(preferenceWriteTimer.current);
    preferenceWriteTimer.current = null;
    persistLatestListState();
  }, [persistLatestListState]);

  useEffect(() => {
    if (isNarrow) setMobileSidebarOpen(false);
  }, [isNarrow]);

  const model = useMemo(() => deriveDocumentListModel({
    pdfDocuments: pdfDocs,
    epubDocuments: epubDocs,
    htmlDocuments: htmlDocs,
    serverFolders: folderState.query.data ?? [],
    sidebarFilter: listState.sidebarFilter,
    query,
    sortBy: listState.sortBy,
    sortDirection: listState.sortDirection,
  }), [
    epubDocs,
    folderState.query.data,
    htmlDocs,
    listState.sidebarFilter,
    listState.sortBy,
    listState.sortDirection,
    pdfDocs,
    query,
  ]);

  const requestDeleteDocument = useCallback((document: DocumentListDocument) => {
    setDocumentToDelete({ id: document.id, name: document.name, type: document.type });
  }, []);
  const confirmDeleteDocument = useCallback(async () => {
    if (!documentToDelete) return;
    try {
      await deleteDocument(documentToDelete.id);
      setDocumentToDelete(null);
    } catch (error) {
      console.error('Failed to remove document:', error);
    }
  }, [deleteDocument, documentToDelete]);

  const dropOnFolder = useCallback((folderId: string, item: DocumentDragItem) => {
    folderState.move.mutate({ documentIds: item.docs.map((document) => document.id), folderId });
    updateListState({ sidebarFilter: `folder:${folderId}` });
    selection.clear();
  }, [folderState.move, selection, updateListState]);

  const requestMergeIntoFolder = useCallback((
    sources: DocumentListDocument[],
    target: DocumentListDocument,
  ) => {
    if (target.folderId) return;
    const targetKey = documentIdentityKey(target);
    const eligibleSources = sources.filter((source) =>
      documentIdentityKey(source) !== targetKey && !source.folderId,
    );
    if (eligibleSources.length === 0) return;
    setPendingMerge({ sources: eligibleSources, target });
    setNewFolderName('');
  }, []);

  const confirmPendingFolder = useCallback(async () => {
    if (!pendingMerge) return;
    const name = newFolderName.trim()
      || suggestFolderName(pendingMerge.sources[0], pendingMerge.target);
    const documentIds = [...pendingMerge.sources, pendingMerge.target].map((document) => document.id);
    const folderId = crypto.randomUUID();
    setPendingMerge(null);
    setNewFolderName('');
    updateListState({ showHint: false, sidebarFilter: `folder:${folderId}` });
    selection.clear();
    try {
      const { folder } = await folderState.create.mutateAsync({ id: folderId, name, documentIds });
      updateListState({ sidebarFilter: `folder:${folder.id}` });
    } catch (error) {
      console.error('Failed to create folder:', error);
      updateListState({ sidebarFilter: 'all' });
    }
  }, [folderState.create, newFolderName, pendingMerge, selection, updateListState]);

  const openManualFolderPrompt = useCallback(() => {
    setNewFolderName('');
    setManualFolderPrompt(true);
  }, []);
  const confirmManualFolder = useCallback(() => {
    folderState.create.mutate({ name: newFolderName.trim() || 'New Folder' });
    setNewFolderName('');
    setManualFolderPrompt(false);
    updateListState({ sidebarFilter: 'all' });
  }, [folderState.create, newFolderName, updateListState]);
  const deleteFolder = useCallback((folderId: string) => {
    folderState.remove.mutate(folderId);
    if (listState.sidebarFilter === `folder:${folderId}`) {
      updateListState({ sidebarFilter: 'all' });
    }
  }, [folderState.remove, listState.sidebarFilter, updateListState]);
  const confirmClearFolders = useCallback(() => {
    folderState.clear.mutate();
    if (listState.sidebarFilter.startsWith('folder:')) {
      updateListState({ sidebarFilter: 'all' });
    }
    setClearFoldersPrompt(false);
    selection.clear();
  }, [folderState.clear, listState.sidebarFilter, selection, updateListState]);

  const retryQueries = useCallback(() => {
    void Promise.allSettled([
      refreshDocuments(),
      folderState.query.refetch(),
      preferencesQuery.refetch(),
    ]);
  }, [folderState.query, preferencesQuery, refreshDocuments]);

  const handleUploadBatchChange = useCallback((state: UploadBatchState) => {
    setActiveUploadBatches((previous) => {
      if (!state.isActive) {
        if (!previous[state.uploaderId]) return previous;
        const next = { ...previous };
        delete next[state.uploaderId];
        return next;
      }
      return { ...previous, [state.uploaderId]: state };
    });
  }, []);
  const sidebarUploadState = useMemo(() => {
    const batches = Object.values(activeUploadBatches);
    if (batches.length === 0) return null;
    return {
      totalFiles: batches.reduce((sum, batch) => sum + batch.totalFiles, 0),
      completedFiles: batches.reduce((sum, batch) => sum + batch.completedFiles, 0),
      currentFileName: batches.find((batch) => batch.currentFileName)?.currentFileName ?? null,
      phase: 'uploading' as const,
    };
  }, [activeUploadBatches]);
  const visibleSelectedCount = useMemo(
    () => model.visibleDocuments.reduce(
      (count, document) => count + (selection.isSelected(document) ? 1 : 0),
      0,
    ),
    [model.visibleDocuments, selection],
  );

  return {
    listState,
    model,
    query,
    setQuery,
    updateListState,
    isNarrow,
    effectiveSidebarOpen: isNarrow ? mobileSidebarOpen : !listState.sidebarCollapsed,
    toggleSidebar: () => {
      if (isNarrow) setMobileSidebarOpen((open) => !open);
      else updateListState({ sidebarCollapsed: !listState.sidebarCollapsed });
    },
    closeMobileSidebar: () => {
      if (isNarrow) setMobileSidebarOpen(false);
    },
    documentsQueryState,
    retryQueries,
    visibleSelectedCount,
    requestDeleteDocument,
    documentToDelete,
    cancelDeleteDocument: () => setDocumentToDelete(null),
    confirmDeleteDocument,
    dropOnFolder,
    requestMergeIntoFolder,
    pendingMerge,
    cancelPendingFolder: () => {
      setPendingMerge(null);
      setNewFolderName('');
    },
    confirmPendingFolder,
    newFolderName,
    setNewFolderName,
    manualFolderPrompt,
    openManualFolderPrompt,
    cancelManualFolder: () => {
      setManualFolderPrompt(false);
      setNewFolderName('');
    },
    confirmManualFolder,
    deleteFolder,
    clearFoldersPrompt,
    requestClearFolders: () => setClearFoldersPrompt(true),
    cancelClearFolders: () => setClearFoldersPrompt(false),
    confirmClearFolders,
    sidebarUploadState,
    handleUploadBatchChange,
    isUploadDialogOpen,
    openUploadDialog: () => setIsUploadDialogOpen(true),
    closeUploadDialog: () => setIsUploadDialogOpen(false),
  };
}
