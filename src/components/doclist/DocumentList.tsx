'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useDocuments } from '@/contexts/DocumentContext';
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
import {
  getDocumentListState,
  getDocumentRecentlyOpenedMap,
  saveDocumentListState,
} from '@/lib/client/dexie';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { DocumentUploader, type UploadBatchState } from '@/components/documents/DocumentUploader';
import { IconButton } from '@/components/ui';
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

let cachedDocumentListState: DocumentListState | null = null;

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

function DocumentListStateLoader() {
  return (
    <div
      className="h-full w-full min-h-0 bg-surface-sunken animate-pulse"
      aria-label="Loading documents"
      aria-busy="true"
    />
  );
}

function DocumentListInner({ brand, appActions }: DocumentListInnerProps) {
  const cachedState = cachedDocumentListState;
  const [sortBy, setSortBy] = useState<SortBy>(cachedState?.sortBy ?? DEFAULT_STATE.sortBy);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    cachedState?.sortDirection ?? DEFAULT_STATE.sortDirection,
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(cachedState?.viewMode ?? DEFAULT_STATE.viewMode),
  );
  const [iconSize, setIconSize] = useState<IconSize>(cachedState?.iconSize ?? DEFAULT_STATE.iconSize);
  const [folders, setFolders] = useState<Folder[]>(cachedState?.folders ?? DEFAULT_STATE.folders);
  const [showHint, setShowHint] = useState(cachedState?.showHint ?? true);
  const [sidebarWidth, setSidebarWidth] = useState(cachedState?.sidebarWidth ?? DEFAULT_STATE.sidebarWidth);
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>(cachedState?.sidebarFilter ?? 'all');
  const [sidebarOpen, setSidebarOpen] = useState(!(cachedState?.sidebarCollapsed ?? false));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeUploadBatches, setActiveUploadBatches] = useState<Record<string, UploadBatchState>>({});

  const [isInitialized, setIsInitialized] = useState(cachedState !== null);

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

  const {
    pdfDocs,
    isPDFLoading,
    epubDocs,
    isEPUBLoading,
    htmlDocs,
    deleteDocument,
    isHTMLLoading,
  } = useDocuments();

  // Load saved state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getDocumentListState();
      if (cancelled) return;
      if (saved) {
        cachedDocumentListState = saved;
        setSortBy(saved.sortBy);
        setSortDirection(saved.sortDirection);
        setFolders(saved.folders ?? []);
        setShowHint(saved.showHint ?? true);
        setViewMode(normalizeViewMode(saved.viewMode));
        setIconSize(saved.iconSize ?? DEFAULT_STATE.iconSize);
        setSidebarWidth(saved.sidebarWidth ?? DEFAULT_STATE.sidebarWidth);
        setSidebarFilter(saved.sidebarFilter ?? 'all');
        setSidebarOpen(!(saved.sidebarCollapsed ?? false));
      } else {
        cachedDocumentListState = null;
        setSortBy(DEFAULT_STATE.sortBy);
        setSortDirection(DEFAULT_STATE.sortDirection);
        setFolders(DEFAULT_STATE.folders);
        setShowHint(DEFAULT_STATE.showHint);
        setViewMode(DEFAULT_STATE.viewMode);
        setIconSize(DEFAULT_STATE.iconSize);
        setSidebarWidth(DEFAULT_STATE.sidebarWidth);
        setSidebarFilter(DEFAULT_STATE.sidebarFilter);
        setSidebarOpen(!DEFAULT_STATE.sidebarCollapsed);
      }
      setIsInitialized(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist.
  useEffect(() => {
    if (!isInitialized) return;
    const state: DocumentListState = {
      sortBy,
      sortDirection,
      folders,
      collapsedFolders: [],
      showHint,
      viewMode,
      iconSize,
      sidebarWidth,
      sidebarFilter,
      sidebarCollapsed: !sidebarOpen,
    };
    cachedDocumentListState = state;
    void saveDocumentListState(state);
  }, [
    sortBy,
    sortDirection,
    folders,
    showHint,
    viewMode,
    iconSize,
    sidebarWidth,
    sidebarFilter,
    sidebarOpen,
    isInitialized,
  ]);

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
  const rawDocumentIdsKey = useMemo(
    () => rawDocuments.map((d) => documentIdentityKey(d)).sort().join('|'),
    [rawDocuments],
  );
  const recentlyOpenedById = useLiveQuery<Record<string, number>, Record<string, number>>(
    async () => {
      try {
        return await getDocumentRecentlyOpenedMap();
      } catch (err) {
        console.warn('Failed to load recently opened cache metadata:', err);
        return {};
      }
    },
    [rawDocumentIdsKey],
    {},
  );

  const allDocuments: DocumentListDocument[] = useMemo(
    () =>
      rawDocuments.map((doc) => ({
        ...doc,
        recentlyOpenedAt: recentlyOpenedById[documentIdentityKey(doc)] ?? 0,
      })),
    [rawDocuments, recentlyOpenedById],
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
      setFolders((prev) =>
        prev.map((f) => ({
          ...f,
          documents: f.documents.filter(
            (d) => !(d.id === documentToDelete.id && d.type === documentToDelete.type),
          ),
        })),
      );
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
      setFolders((prev) =>
        prev.map((f) => {
          if (f.id !== folderId) {
            // Remove the dropped docs from any other folder they were in.
            return {
              ...f,
              documents: f.documents.filter(
                (d) => !item.items.some((it) => it.id === d.id && it.type === d.type),
              ),
            };
          }
          const existingIdentities = new Set(f.documents.map((d) => documentIdentityKey(d)));
          const newDocs = item.docs
            .filter((d) => !existingIdentities.has(documentIdentityKey(d)))
            .map((d) => ({ ...d, folderId }));
          return { ...f, documents: [...f.documents, ...newDocs] };
        }),
      );
      setSidebarFilter(`folder:${folderId}`);
      selection.clear();
    },
    [selection],
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

  const createFolderFromPending = useCallback(() => {
    if (!pendingMerge) return;
    const name =
      newFolderName.trim() ||
      generateDefaultFolderName(pendingMerge.sources[0], pendingMerge.target);
    const folderId = `folder-${Date.now()}`;
    setFolders((prev) => [
      ...prev,
      {
        id: folderId,
        name,
        documents: [
          ...pendingMerge.sources.map((d) => ({ ...d, folderId })),
          { ...pendingMerge.target, folderId },
        ],
      },
    ]);
    setPendingMerge(null);
    setNewFolderName('');
    setShowHint(false);
    setSidebarFilter(`folder:${folderId}`);
    selection.clear();
  }, [pendingMerge, newFolderName, selection]);

  const createManualFolder = useCallback(() => {
    const name = newFolderName.trim() || `New Folder`;
    const folderId = `folder-${Date.now()}`;
    setFolders((prev) => [...prev, { id: folderId, name, documents: [] }]);
    setNewFolderName('');
    setManualFolderPrompt(false);
    setSidebarFilter(`folder:${folderId}`);
  }, [newFolderName]);

  const handleDeleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    if (sidebarFilter === `folder:${folderId}`) setSidebarFilter('all');
  }, [sidebarFilter]);

  const handleClearFolders = useCallback(() => {
    setFolders([]);
    if (sidebarFilter.startsWith('folder:')) setSidebarFilter('all');
    setClearFoldersPrompt(false);
    selection.clear();
  }, [selection, sidebarFilter]);

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

  const isLoading = isPDFLoading || isEPUBLoading || isHTMLLoading;

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
          onViewModeChange={setViewMode}
          iconSize={iconSize}
          onIconSizeChange={setIconSize}
          sortBy={sortBy}
          sortDirection={sortDirection}
          onSortByChange={setSortBy}
          onSortDirectionToggle={() =>
            setSortDirection((p) => (p === 'asc' ? 'desc' : 'asc'))
          }
          query={query}
          onQueryChange={setQuery}
          onToggleSidebar={() =>
            isNarrow
              ? setMobileSidebarOpen((p) => !p)
              : setSidebarOpen((p) => !p)
          }
          isSidebarOpen={effectiveSidebarOpen}
          showSortControls={sidebarFilter !== 'recents'}
          leftSlot={brand}
        />
      }
      sidebar={
        <FinderSidebar
          filter={sidebarFilter}
          onFilterChange={setSidebarFilter}
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
          onWidthChange={setSidebarWidth}
          topSlot={<DocumentUploader variant="compact" onUploadBatchChange={handleUploadBatchChange} />}
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
      {!isLoading && showHint && allDocuments.length > 1 && (
        <div className="px-3 pt-3 shrink-0 bg-surface-sunken">
          <div className="flex items-center justify-between bg-surface border border-line rounded-md px-3 py-1 text-[12px]">
            <p className="text-foreground">
              Drag files onto each other to make folders. Drop into the sidebar to move.
            </p>
            <IconButton
              onClick={() => setShowHint(false)}
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

      {isLoading ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          {isInitialized ? (
            <DocumentListSkeleton viewMode={fallbackViewMode} iconSize={iconSize} />
          ) : (
            <DocumentListStateLoader />
          )}
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
              onSortChange={(b, d) => {
                setSortBy(b);
                setSortDirection(d);
              }}
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
