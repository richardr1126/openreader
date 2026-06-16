'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDocuments } from '@/contexts/DocumentContext';
import { queryKeys } from '@/lib/client/query-keys';
import type { PreferencesResponse } from '@/lib/client/api/user-state';
import type {
  DocumentListDocument,
  DocumentListState,
  Folder,
  IconSize,
  SidebarFilter,
  SortBy,
  SortDirection,
  ViewMode,
} from '@/types/documents';
import { useFolders } from '@/hooks/useFolders';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { useAuthSession } from '@/hooks/useAuthSession';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { DocumentUploader, type UploadBatchState } from '@/components/documents/DocumentUploader';
import { IconButton } from '@/components/ui';
import { QueryError, RefreshIndicator } from '@/components/ui/query-states';
import { UploadMenuDialog } from '@/components/documents/UploadMenuDialog';
import { DocumentDndProvider } from './dnd/DocumentDndProvider';
import {
  DocumentSelectionProvider,
  useDocumentSelection,
} from './dnd/DocumentSelectionContext';
import { documentIdentityKey, type DocumentDragItem } from './dnd/dndTypes';
import { FinderWindow, useIsNarrow } from './window/FinderWindow';
import { FinderToolbar } from './window/FinderToolbar';
import { FinderSidebar } from './window/FinderSidebar';
import { FinderStatusBar } from './window/FinderStatusBar';
import { IconsView } from './views/IconsView';
import { ListView } from './views/ListView';
import { GalleryView } from './views/GalleryView';

type DocumentToDelete = {
  id: string;
  name: string;
  type: DocumentListDocument['type'];
};

const DEFAULT_STATE: Required<
  Pick<
    DocumentListState,
    'sortBy' | 'sortDirection' | 'folders' | 'collapsedFolders' | 'showHint'
  >
> & {
  viewMode: ViewMode;
  iconSize: IconSize;
  sidebarWidth: number;
  sidebarFilter: SidebarFilter;
  sidebarCollapsed: boolean;
} = {
  sortBy: 'name',
  sortDirection: 'asc',
  folders: [],
  collapsedFolders: [],
  showHint: true,
  viewMode: 'icons',
  iconSize: 'md',
  sidebarWidth: 220,
  sidebarFilter: 'all',
  sidebarCollapsed: false,
};

function normalizeViewMode(stored: DocumentListState['viewMode']): ViewMode {
  if (stored === 'grid' || stored === undefined) return 'icons';
  if (stored === 'list') return 'list';
  if (stored === 'gallery') return 'gallery';
  return 'icons';
}

// Fully-resolved toolbar/layout preferences. Server preferences may omit fields
// (older clients, partial writes); normalize to concrete values for rendering.
type NormalizedListState = {
  sortBy: SortBy;
  sortDirection: SortDirection;
  showHint: boolean;
  viewMode: ViewMode;
  iconSize: IconSize;
  sidebarWidth: number;
  sidebarFilter: SidebarFilter;
  sidebarCollapsed: boolean;
};

function normalizeListState(stored: DocumentListState | undefined | null): NormalizedListState {
  return {
    sortBy: stored?.sortBy ?? DEFAULT_STATE.sortBy,
    sortDirection: stored?.sortDirection ?? DEFAULT_STATE.sortDirection,
    showHint: stored?.showHint ?? DEFAULT_STATE.showHint,
    viewMode: normalizeViewMode(stored?.viewMode ?? DEFAULT_STATE.viewMode),
    iconSize: stored?.iconSize ?? DEFAULT_STATE.iconSize,
    sidebarWidth: stored?.sidebarWidth ?? DEFAULT_STATE.sidebarWidth,
    sidebarFilter: stored?.sidebarFilter ?? DEFAULT_STATE.sidebarFilter,
    sidebarCollapsed: stored?.sidebarCollapsed ?? DEFAULT_STATE.sidebarCollapsed,
  };
}

function toStoredListState(state: NormalizedListState): DocumentListState {
  return {
    sortBy: state.sortBy,
    sortDirection: state.sortDirection,
    // `folders`/`collapsedFolders` are obsolete membership fields kept only for
    // the persisted shape; folder membership now lives on documents[].folderId.
    folders: [],
    collapsedFolders: [],
    showHint: state.showHint,
    viewMode: state.viewMode,
    iconSize: state.iconSize,
    sidebarWidth: state.sidebarWidth,
    sidebarFilter: state.sidebarFilter,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}

function generateDefaultFolderName(
  doc1: DocumentListDocument,
  doc2: DocumentListDocument,
): string {
  const words1 = doc1.name.toLowerCase().split(/[\s\-_.]+/);
  const words2 = doc2.name.toLowerCase().split(/[\s\-_.]+/);
  const common = words1.filter((w) => words2.includes(w));
  const significant = common.find((w) => w.length >= 3);
  if (significant) {
    if (significant === 'pdf') return 'PDFs';
    if (significant === 'epub') return 'EPUBs';
    if (significant === 'txt' || significant === 'md') return 'Documents';
    return significant.charAt(0).toUpperCase() + significant.slice(1);
  }
  const timestamp = new Date().toISOString().slice(0, 10);
  return `Folder ${timestamp}`;
}

function sortDocs(
  docs: DocumentListDocument[],
  sortBy: SortBy,
  direction: SortDirection,
): DocumentListDocument[] {
  const sorted = [...docs].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'type':
        return a.type.localeCompare(b.type);
      case 'size':
        return a.size - b.size;
      default:
        return a.lastModified - b.lastModified;
    }
  });
  return direction === 'asc' ? sorted : sorted.reverse();
}

interface DocumentListInnerProps {
  brand?: ReactNode;
  appActions?: ReactNode;
}

function SidebarUploadLoader({
  totalFiles,
  completedFiles,
  currentFileName,
}: {
  totalFiles: number;
  completedFiles: number;
  phase: 'uploading';
  currentFileName: string | null;
}) {
  const progress = totalFiles > 0 ? Math.min(100, Math.round((completedFiles / totalFiles) * 100)) : 0;
  const radius = 7;
  const stroke = 2;
  const size = 18;
  const normalizedRadius = radius - stroke / 2;
  const circumference = 2 * Math.PI * normalizedRadius;
  const dashOffset = circumference - (progress / 100) * circumference;

  return (
    <div className="rounded-md border border-line bg-surface-sunken px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5 text-[11px] leading-tight">
          <span className="font-medium text-foreground">Uploading</span>
          <span className="shrink-0 tabular-nums text-soft">{completedFiles}/{totalFiles}</span>
        </div>
        <div className="shrink-0 flex items-center gap-1 text-accent" aria-label={`Upload progress ${progress}%`}>
          <span className="text-[10px] tabular-nums text-soft">{progress}%</span>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={normalizedRadius}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={normalizedRadius}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: 'stroke-dashoffset 200ms ease-standard' }}
            />
          </svg>
        </div>
      </div>
      {currentFileName && (
        <p className="mt-0.5 truncate text-[10px] text-soft" title={currentFileName}>
          {currentFileName}
        </p>
      )}
    </div>
  );
}

function DocumentListInner({ brand, appActions }: DocumentListInnerProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeUploadBatches, setActiveUploadBatches] = useState<Record<string, UploadBatchState>>({});
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);

  const preferenceWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [documentToDelete, setDocumentToDelete] = useState<DocumentToDelete | null>(null);
  const [pendingMerge, setPendingMerge] = useState<
    | { sources: DocumentListDocument[]; target: DocumentListDocument }
    | null
  >(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [manualFolderPrompt, setManualFolderPrompt] = useState(false);
  const [clearFoldersPrompt, setClearFoldersPrompt] = useState(false);

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
  const {
    query: preferencesQuery,
    mutation: preferencesMutation,
  } = useUserPreferences(sessionId, !isSessionPending);
  const persistPreferences = preferencesMutation.mutate;
  const folderState = useFolders();

  const preferencesKey = queryKeys.preferences(sessionId);

  // Toolbar/layout choices are server preferences, not React state. Read them
  // straight from the preferences query and write changes back through a
  // debounced optimistic mutation. There is no copy-into-state / sync-back
  // effect and no module-level cache mirror.
  const listState = useMemo(
    () => normalizeListState(preferencesQuery.data?.preferences.documentListState),
    [preferencesQuery.data?.preferences.documentListState],
  );
  const { sortBy, sortDirection, viewMode, iconSize, showHint, sidebarWidth, sidebarFilter } = listState;
  const sidebarOpen = !listState.sidebarCollapsed;

  const persistLatestListState = useCallback(() => {
    const latest = queryClient.getQueryData<PreferencesResponse>(preferencesKey);
    persistPreferences({
      documentListState: toStoredListState(normalizeListState(latest?.preferences?.documentListState)),
    });
  }, [persistPreferences, preferencesKey, queryClient]);

  const updateListState = useCallback(
    (patch: Partial<NormalizedListState>, persistImmediately = false) => {
      // 1) Update the preferences cache immediately so the UI is responsive.
      queryClient.setQueryData<PreferencesResponse>(preferencesKey, (prev) => ({
        preferences: {
          ...(prev?.preferences ?? {}),
          documentListState: toStoredListState({
            ...normalizeListState(prev?.preferences?.documentListState),
            ...patch,
          }),
        },
        clientUpdatedAtMs: Date.now(),
        hasStoredPreferences: true,
      }));
      // 2) Debounce the write-through to the server, coalescing rapid changes
      //    (sort toggles, sidebar drag) into a single mutation.
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
    },
    [persistLatestListState, preferencesKey, queryClient],
  );

  useEffect(
    () => () => {
      // Flush a queued debounced write on unmount so the latest toolbar/layout
      // change is persisted instead of being dropped during the debounce window.
      if (preferenceWriteTimer.current) {
        clearTimeout(preferenceWriteTimer.current);
        preferenceWriteTimer.current = null;
        persistLatestListState();
      }
    },
    [persistLatestListState],
  );

  // Mobile drawer should never auto-open from persisted desktop state.
  useEffect(() => {
    if (!isNarrow) return;
    setMobileSidebarOpen(false);
  }, [isNarrow]);

  // Build the union document list.
  const rawDocuments: DocumentListDocument[] = useMemo(
    () => [
      ...pdfDocs.map((d) => ({ ...d, type: 'pdf' as const })),
      ...epubDocs.map((d) => ({ ...d, type: 'epub' as const })),
      ...htmlDocs.map((d) => ({ ...d, type: 'html' as const })),
    ],
    [pdfDocs, epubDocs, htmlDocs],
  );
  const allDocuments: DocumentListDocument[] = useMemo(
    () =>
      rawDocuments.map((doc) => ({
        ...doc,
        recentlyOpenedAt: doc.recentlyOpenedAt ?? 0,
      })),
    [rawDocuments],
  );

  // Folders are derived directly from the authoritative folders query plus each
  // document's folderId. The folder mutations in useFolders update the documents
  // and folders query caches optimistically, so there is no local folder mirror
  // to keep in sync.
  const folders: Folder[] = useMemo(
    () =>
      (folderState.query.data ?? []).map((folder) => ({
        id: folder.id,
        name: folder.name,
        documents: rawDocuments
          .filter((doc) => doc.folderId === folder.id)
          .map((doc) => ({ ...doc, folderId: folder.id })),
      })),
    [folderState.query.data, rawDocuments],
  );

  const allDocumentsById = useMemo(() => {
    const map = new Map<string, DocumentListDocument>();
    for (const doc of allDocuments) map.set(documentIdentityKey(doc), doc);
    return map;
  }, [allDocuments]);

  const foldersWithLiveDocs = useMemo(
    () =>
      folders.map((folder) => ({
        ...folder,
        documents: folder.documents
          .map((d) => allDocumentsById.get(documentIdentityKey(d)))
          .filter((d): d is DocumentListDocument => Boolean(d))
          .map((d) => ({ ...d, folderId: folder.id })),
      })),
    [folders, allDocumentsById],
  );

  const folderNameById = useMemo(
    () =>
      foldersWithLiveDocs.reduce<Record<string, string>>((acc, folder) => {
        acc[folder.id] = folder.name;
        return acc;
      }, {}),
    [foldersWithLiveDocs],
  );

  const folderIdByDocId = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of foldersWithLiveDocs) {
      for (const doc of folder.documents) map.set(documentIdentityKey(doc), folder.id);
    }
    return map;
  }, [foldersWithLiveDocs]);

  const allDocumentsWithFolder = useMemo(
    () =>
      allDocuments.map((doc) => ({
        ...doc,
        folderId: folderIdByDocId.get(documentIdentityKey(doc)),
      })),
    [allDocuments, folderIdByDocId],
  );

  // Filter based on sidebar selection + search query.
  const visibleDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    let docs = allDocumentsWithFolder;
    if (sidebarFilter === 'pdf') docs = docs.filter((d) => d.type === 'pdf');
    else if (sidebarFilter === 'epub') docs = docs.filter((d) => d.type === 'epub');
    else if (sidebarFilter === 'html') docs = docs.filter((d) => d.type === 'html');
    else if (sidebarFilter === 'recents') {
      docs = [...docs]
        .filter((d) => (d.recentlyOpenedAt ?? 0) > 0)
        .sort((a, b) => (b.recentlyOpenedAt ?? 0) - (a.recentlyOpenedAt ?? 0))
        .slice(0, 20);
    } else if (sidebarFilter.startsWith('folder:')) {
      const fid = sidebarFilter.slice('folder:'.length);
      const folder = foldersWithLiveDocs.find((f) => f.id === fid);
      docs = folder
        ? folder.documents
            .map((d) => allDocumentsById.get(documentIdentityKey(d)))
            .filter((d): d is DocumentListDocument => Boolean(d))
            .map((d) => ({ ...d, folderId: fid }))
        : [];
    }
    if (q) docs = docs.filter((d) => d.name.toLowerCase().includes(q));
    return docs;
  }, [allDocumentsWithFolder, sidebarFilter, query, foldersWithLiveDocs, allDocumentsById]);

  // Apply sort.
  const sortedVisible = useMemo(() => {
    if (sidebarFilter === 'recents') return visibleDocuments;
    return sortDocs(visibleDocuments, sortBy, sortDirection);
  }, [visibleDocuments, sidebarFilter, sortBy, sortDirection]);

  const counts = useMemo(
    () => ({
      all: allDocuments.length,
      pdf: pdfDocs.length,
      epub: epubDocs.length,
      html: htmlDocs.length,
    }),
    [allDocuments.length, pdfDocs.length, epubDocs.length, htmlDocs.length],
  );

  // --- Actions ---

  const handleDelete = useCallback(async () => {
    if (!documentToDelete) return;
    try {
      await deleteDocument(documentToDelete.id);
      setDocumentToDelete(null);
    } catch (err) {
      console.error('Failed to remove document:', err);
    }
  }, [deleteDocument, documentToDelete]);

  const handleDeleteDoc = useCallback((doc: DocumentListDocument) => {
    setDocumentToDelete({ id: doc.id, name: doc.name, type: doc.type });
  }, []);

  const handleDropOnFolder = useCallback(
    (folderId: string, item: DocumentDragItem) => {
      // useFolders.move optimistically reassigns documents[].folderId, which the
      // derived `folders` memo reflects immediately.
      folderState.move.mutate({ documentIds: item.docs.map((doc) => doc.id), folderId });
      updateListState({ sidebarFilter: `folder:${folderId}` });
      selection.clear();
    },
    [folderState.move, selection, updateListState],
  );

  const handleMergeIntoFolder = useCallback(
    (sources: DocumentListDocument[], target: DocumentListDocument) => {
      if (target.folderId) return;
      const targetKey = documentIdentityKey(target);
      const filtered = sources.filter((s) => documentIdentityKey(s) !== targetKey && !s.folderId);
      if (filtered.length === 0) return;
      setPendingMerge({ sources: filtered, target });
      setNewFolderName('');
    },
    [],
  );

  const createFolderFromPending = useCallback(async () => {
    if (!pendingMerge) return;
    const name =
      newFolderName.trim() ||
      generateDefaultFolderName(pendingMerge.sources[0], pendingMerge.target);
    const documentIds = [...pendingMerge.sources, pendingMerge.target].map((doc) => doc.id);
    const folderId = crypto.randomUUID();
    setPendingMerge(null);
    setNewFolderName('');
    updateListState({ showHint: false, sidebarFilter: `folder:${folderId}` });
    selection.clear();
    try {
      const { folder } = await folderState.create.mutateAsync({
        id: folderId,
        name,
        documentIds,
      });
      updateListState({ sidebarFilter: `folder:${folder.id}` });
    } catch (error) {
      // The mutation surfaces the failure via its error state; fall back to the
      // full library so we don't strand the user on a folder that was never
      // created.
      console.error('Failed to create folder:', error);
      updateListState({ sidebarFilter: 'all' });
    }
  }, [folderState.create, pendingMerge, newFolderName, selection, updateListState]);

  const handleDismissHint = useCallback(() => {
    updateListState({ showHint: false }, true);
  }, [updateListState]);

  const createManualFolder = useCallback(() => {
    const name = newFolderName.trim() || `New Folder`;
    folderState.create.mutate({ name });
    setNewFolderName('');
    setManualFolderPrompt(false);
    updateListState({ sidebarFilter: 'all' });
  }, [folderState.create, newFolderName, updateListState]);

  const handleDeleteFolder = useCallback((folderId: string) => {
    folderState.remove.mutate(folderId);
    if (sidebarFilter === `folder:${folderId}`) updateListState({ sidebarFilter: 'all' });
  }, [folderState.remove, sidebarFilter, updateListState]);

  const handleClearFolders = useCallback(() => {
    folderState.clear.mutate();
    if (sidebarFilter.startsWith('folder:')) updateListState({ sidebarFilter: 'all' });
    setClearFoldersPrompt(false);
    selection.clear();
  }, [folderState.clear, selection, sidebarFilter, updateListState]);

  // Status bar summary.
  const summary = useMemo(() => {
    const parts: string[] = [];
    if (counts.pdf) parts.push(`${counts.pdf} PDF${counts.pdf === 1 ? '' : 's'}`);
    if (counts.epub) parts.push(`${counts.epub} EPUB${counts.epub === 1 ? '' : 's'}`);
    if (counts.html) parts.push(`${counts.html} Text${counts.html === 1 ? ' Doc' : ' Docs'}`);
    return parts.join(' • ');
  }, [counts]);

  const totalBytes = useMemo(
    () => allDocuments.reduce((acc, d) => acc + d.size, 0),
    [allDocuments],
  );
  const visibleSelectedCount = useMemo(
    () => sortedVisible.reduce((count, doc) => count + (selection.isSelected(doc) ? 1 : 0), 0),
    [sortedVisible, selection],
  );

  // The content area reflects the documents query alone. Folders feed the
  // sidebar and preferences feed the toolbar — both have safe defaults, so a
  // slow or failed folders/preferences fetch must not blank out or block the
  // document list. Their refresh/error feedback is surfaced in their own UI.
  const { initialLoading, error: queryError } = documentsQueryState;
  const refetchFolders = folderState.query.refetch;
  const refetchPreferences = preferencesQuery.refetch;
  const retryQueries = useCallback(() => {
    void Promise.allSettled([
      refreshDocuments(),
      refetchFolders(),
      refetchPreferences(),
    ]);
  }, [refetchFolders, refetchPreferences, refreshDocuments]);

  const handleUploadBatchChange = useCallback((state: UploadBatchState) => {
    setActiveUploadBatches((prev) => {
      if (!state.isActive) {
        if (!prev[state.uploaderId]) return prev;
        const next = { ...prev };
        delete next[state.uploaderId];
        return next;
      }
      return { ...prev, [state.uploaderId]: state };
    });
  }, []);

  const sidebarUploadState = useMemo(() => {
    const batches = Object.values(activeUploadBatches);
    if (batches.length === 0) return null;
    const totalFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
    const completedFiles = batches.reduce((sum, batch) => sum + batch.completedFiles, 0);
    const currentFileName = batches.find((batch) => batch.currentFileName)?.currentFileName ?? null;
    return { totalFiles, completedFiles, phase: 'uploading' as const, currentFileName };
  }, [activeUploadBatches]);

  const fallbackViewMode: ViewMode = viewMode;
  const effectiveSidebarOpen = isNarrow ? mobileSidebarOpen : sidebarOpen;

  return (
    <FinderWindow
      toolbar={
        <FinderToolbar
          viewMode={fallbackViewMode}
          onViewModeChange={(mode) => updateListState({ viewMode: mode })}
          iconSize={iconSize}
          onIconSizeChange={(size) => updateListState({ iconSize: size })}
          sortBy={sortBy}
          sortDirection={sortDirection}
          onSortByChange={(by) => updateListState({ sortBy: by })}
          onSortDirectionToggle={() =>
            updateListState({ sortDirection: sortDirection === 'asc' ? 'desc' : 'asc' })
          }
          query={query}
          onQueryChange={setQuery}
          onToggleSidebar={() =>
            isNarrow
              ? setMobileSidebarOpen((p) => !p)
              : updateListState({ sidebarCollapsed: !listState.sidebarCollapsed })
          }
          isSidebarOpen={effectiveSidebarOpen}
          showSortControls={sidebarFilter !== 'recents'}
          leftSlot={brand}
        />
      }
      sidebar={
        <FinderSidebar
          filter={sidebarFilter}
          onFilterChange={(filter) => updateListState({ sidebarFilter: filter })}
          folders={foldersWithLiveDocs}
          counts={counts}
          onDeleteFolder={handleDeleteFolder}
          onNewFolder={() => {
            setNewFolderName('');
            setManualFolderPrompt(true);
          }}
          onClearFolders={() => setClearFoldersPrompt(true)}
          onDropOnFolder={handleDropOnFolder}
          width={sidebarWidth}
          onWidthChange={(width) => updateListState({ sidebarWidth: width })}
          topSlot={(
            <DocumentUploader
              variant="compact"
              onUploadBatchChange={handleUploadBatchChange}
              onClick={() => setIsUploadDialogOpen(true)}
            />
          )}
          bottomSlot={(
            <div className="flex flex-col gap-2">
              {sidebarUploadState && (
                <SidebarUploadLoader
                  totalFiles={sidebarUploadState.totalFiles}
                  completedFiles={sidebarUploadState.completedFiles}
                  phase={sidebarUploadState.phase}
                  currentFileName={sidebarUploadState.currentFileName}
                />
              )}
              {appActions}
            </div>
          )}
          onRowAction={() => {
            if (isNarrow) setMobileSidebarOpen(false);
          }}
        />
      }
      statusBar={
        <FinderStatusBar
          itemCount={allDocuments.length}
          selectedCount={visibleSelectedCount}
          totalSize={totalBytes}
          summary={summary}
        />
      }
      sidebarOpen={effectiveSidebarOpen}
      onRequestSidebarClose={() => {
        if (isNarrow) setMobileSidebarOpen(false);
      }}
    >
      {!initialLoading && !queryError && showHint && allDocuments.length > 1 && (
        <div className="px-3 pt-3 shrink-0 bg-surface-sunken">
          <div className="flex items-center justify-between bg-surface border border-line rounded-md px-3 py-1 text-[12px]">
            <p className="text-foreground">
              Drag files onto each other to make folders. Drop into the sidebar to move.
            </p>
            <IconButton
              onClick={handleDismissHint}
              size="xs"
              className="h-6 w-6"
              aria-label="Dismiss hint"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </IconButton>
          </div>
        </div>
      )}

      {queryError ? (
        <QueryError
          error={queryError}
          onRetry={retryQueries}
          className="flex-1 min-h-0 px-6"
        />
      ) : initialLoading ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <DocumentListSkeleton viewMode={fallbackViewMode} iconSize={iconSize} />
        </div>
      ) : allDocuments.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <DocumentUploader
            className="py-12 w-full max-w-2xl"
            onUploadBatchChange={handleUploadBatchChange}
          />
        </div>
      ) : (
        <DocumentUploader
          variant="overlay"
          className="flex-1 min-h-0 flex flex-col"
          onUploadBatchChange={handleUploadBatchChange}
        >
          <RefreshIndicator
            refreshing={documentsQueryState.refreshing}
            warn={Boolean(documentsQueryState.backgroundError)}
            className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full border border-line bg-surface-solid px-3 py-1 shadow-elev-1"
          />
          {fallbackViewMode === 'icons' && (
            <IconsView
              documents={sortedVisible}
              iconSize={iconSize}
              onDeleteDoc={handleDeleteDoc}
              onMergeIntoFolder={handleMergeIntoFolder}
            />
          )}
          {fallbackViewMode === 'list' && (
            <ListView
              documents={sortedVisible}
              sortBy={sortBy}
              sortDirection={sortDirection}
              onSortChange={(b, d) => updateListState({ sortBy: b, sortDirection: d })}
              onDeleteDoc={handleDeleteDoc}
              onMergeIntoFolder={handleMergeIntoFolder}
            />
          )}
          {fallbackViewMode === 'gallery' && (
            <GalleryView
              documents={sortedVisible}
              folderNameById={folderNameById}
              onDeleteDoc={handleDeleteDoc}
              onMergeIntoFolder={handleMergeIntoFolder}
            />
          )}
        </DocumentUploader>
      )}

      <CreateFolderDialog
        isOpen={pendingMerge !== null}
        onClose={() => setPendingMerge(null)}
        folderName={newFolderName}
        onFolderNameChange={setNewFolderName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createFolderFromPending();
          } else if (e.key === 'Escape') {
            setPendingMerge(null);
            setNewFolderName('');
          }
        }}
      />

      <CreateFolderDialog
        isOpen={manualFolderPrompt}
        onClose={() => setManualFolderPrompt(false)}
        folderName={newFolderName}
        onFolderNameChange={setNewFolderName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createManualFolder();
          } else if (e.key === 'Escape') {
            setManualFolderPrompt(false);
            setNewFolderName('');
          }
        }}
      />

      <ConfirmDialog
        isOpen={documentToDelete !== null}
        onClose={() => setDocumentToDelete(null)}
        onConfirm={handleDelete}
        title="Delete Document"
        message={`Are you sure you want to delete ${documentToDelete?.name ?? 'this document'}?`}
        confirmText="Delete"
        isDangerous
      />

      <ConfirmDialog
        isOpen={clearFoldersPrompt}
        onClose={() => setClearFoldersPrompt(false)}
        onConfirm={handleClearFolders}
        title="Remove All Folders"
        message="Remove all folders? This will not delete documents."
        confirmText="Remove Folders"
        isDangerous
      />

      <UploadMenuDialog
        isOpen={isUploadDialogOpen}
        onClose={() => setIsUploadDialogOpen(false)}
        onUploadBatchChange={handleUploadBatchChange}
      />
    </FinderWindow>
  );
}

export function DocumentList({
  brand,
  appActions,
}: {
  brand?: ReactNode;
  appActions?: ReactNode;
} = {}) {
  return (
    <DocumentDndProvider>
      <DocumentSelectionProvider>
        <DocumentListInner brand={brand} appActions={appActions} />
      </DocumentSelectionProvider>
    </DocumentDndProvider>
  );
}
