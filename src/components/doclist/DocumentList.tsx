'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { getDocumentListState, saveDocumentListState } from '@/lib/client/dexie';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { DocumentDndProvider } from './dnd/DocumentDndProvider';
import {
  DocumentSelectionProvider,
  useDocumentSelection,
} from './dnd/DocumentSelectionContext';
import type { DocumentDragItem } from './dnd/dndTypes';
import { FinderWindow, useIsNarrow } from './window/FinderWindow';
import { FinderToolbar } from './window/FinderToolbar';
import { FinderSidebar } from './window/FinderSidebar';
import { FinderStatusBar } from './window/FinderStatusBar';
import { IconsView } from './views/IconsView';
import { ListView } from './views/ListView';
import { ColumnsView } from './views/ColumnsView';
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
  return stored;
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

function DocumentListInner({ brand, appActions }: DocumentListInnerProps) {
  const [sortBy, setSortBy] = useState<SortBy>(DEFAULT_STATE.sortBy);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    DEFAULT_STATE.sortDirection,
  );
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_STATE.viewMode);
  const [iconSize, setIconSize] = useState<IconSize>(DEFAULT_STATE.iconSize);
  const [folders, setFolders] = useState<Folder[]>(DEFAULT_STATE.folders);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [showHint, setShowHint] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_STATE.sidebarWidth);
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [query, setQuery] = useState('');

  const [isInitialized, setIsInitialized] = useState(false);

  const [documentToDelete, setDocumentToDelete] = useState<DocumentToDelete | null>(null);
  const [pendingMerge, setPendingMerge] = useState<
    | { sources: DocumentListDocument[]; target: DocumentListDocument }
    | null
  >(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [manualFolderPrompt, setManualFolderPrompt] = useState(false);

  const isNarrow = useIsNarrow();
  const selection = useDocumentSelection();

  const {
    pdfDocs,
    removePDFDocument,
    isPDFLoading,
    epubDocs,
    removeEPUBDocument,
    isEPUBLoading,
    htmlDocs,
    removeHTMLDocument,
    isHTMLLoading,
  } = useDocuments();

  // Load saved state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getDocumentListState();
      if (cancelled) return;
      if (saved) {
        setSortBy(saved.sortBy);
        setSortDirection(saved.sortDirection);
        setFolders(saved.folders ?? []);
        setCollapsedFolders(new Set(saved.collapsedFolders ?? []));
        setShowHint(saved.showHint ?? true);
        setViewMode(normalizeViewMode(saved.viewMode));
        setIconSize(saved.iconSize ?? DEFAULT_STATE.iconSize);
        setSidebarWidth(saved.sidebarWidth ?? DEFAULT_STATE.sidebarWidth);
        setSidebarFilter(saved.sidebarFilter ?? 'all');
        setSidebarOpen(!(saved.sidebarCollapsed ?? false));
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
      collapsedFolders: Array.from(collapsedFolders),
      showHint,
      viewMode,
      iconSize,
      sidebarWidth,
      sidebarFilter,
      sidebarCollapsed: !sidebarOpen,
    };
    void saveDocumentListState(state);
  }, [
    sortBy,
    sortDirection,
    folders,
    collapsedFolders,
    showHint,
    viewMode,
    iconSize,
    sidebarWidth,
    sidebarFilter,
    sidebarOpen,
    isInitialized,
  ]);

  // Build the union document list.
  const allDocuments: DocumentListDocument[] = useMemo(
    () => [
      ...pdfDocs.map((d) => ({ ...d, type: 'pdf' as const })),
      ...epubDocs.map((d) => ({ ...d, type: 'epub' as const })),
      ...htmlDocs.map((d) => ({ ...d, type: 'html' as const })),
    ],
    [pdfDocs, epubDocs, htmlDocs],
  );

  // Reconcile folders against server.
  useEffect(() => {
    if (!isInitialized) return;
    const ids = new Set(allDocuments.map((d) => d.id));
    setFolders((prev) =>
      prev.map((f) => ({
        ...f,
        documents: f.documents.filter((d) => ids.has(d.id)),
      })),
    );
  }, [isInitialized, allDocuments]);

  // Filter based on sidebar selection + search query.
  const visibleAll = useMemo(() => {
    const q = query.trim().toLowerCase();
    let docs = allDocuments;
    if (sidebarFilter === 'pdf') docs = docs.filter((d) => d.type === 'pdf');
    else if (sidebarFilter === 'epub') docs = docs.filter((d) => d.type === 'epub');
    else if (sidebarFilter === 'html') docs = docs.filter((d) => d.type === 'html');
    else if (sidebarFilter === 'recents') {
      docs = [...docs]
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(0, 20);
    } else if (sidebarFilter.startsWith('folder:')) {
      const fid = sidebarFilter.slice('folder:'.length);
      const folder = folders.find((f) => f.id === fid);
      docs = folder ? folder.documents : [];
    }
    if (q) docs = docs.filter((d) => d.name.toLowerCase().includes(q));
    return docs;
  }, [allDocuments, sidebarFilter, query, folders]);

  // Apply sort.
  const sortedVisible = useMemo(
    () => sortDocs(visibleAll, sortBy, sortDirection),
    [visibleAll, sortBy, sortDirection],
  );

  // Split into folders + unfoldered for the current filter context.
  const showAllScope =
    sidebarFilter === 'all' || sidebarFilter === 'recents';
  const visibleFolders = useMemo<Folder[]>(() => {
    if (!showAllScope) return [];
    // Within a kind-filter (pdf/epub/html), still show folders that contain matches.
    return folders.map((f) => ({
      ...f,
      documents: sortDocs(
        f.documents.filter((d) =>
          query ? d.name.toLowerCase().includes(query.toLowerCase()) : true,
        ),
        sortBy,
        sortDirection,
      ),
    }));
  }, [folders, showAllScope, query, sortBy, sortDirection]);

  const unfolderedDocs = useMemo(() => {
    const inFolder = new Set<string>();
    folders.forEach((f) => f.documents.forEach((d) => inFolder.add(d.id)));
    return sortedVisible.filter((d) => !inFolder.has(d.id));
  }, [folders, sortedVisible]);

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
      if (documentToDelete.type === 'pdf') await removePDFDocument(documentToDelete.id);
      else if (documentToDelete.type === 'epub') await removeEPUBDocument(documentToDelete.id);
      else if (documentToDelete.type === 'html') await removeHTMLDocument(documentToDelete.id);
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
  }, [documentToDelete, removePDFDocument, removeEPUBDocument, removeHTMLDocument]);

  const handleDropOnFolder = useCallback(
    (folderId: string, item: DocumentDragItem) => {
      setFolders((prev) =>
        prev.map((f) => {
          if (f.id !== folderId) {
            // Remove the dropped docs from any other folder they were in.
            return {
              ...f,
              documents: f.documents.filter(
                (d) => !item.ids.includes(d.id),
              ),
            };
          }
          const existingIds = new Set(f.documents.map((d) => d.id));
          const newDocs = item.docs
            .filter((d) => !existingIds.has(d.id))
            .map((d) => ({ ...d, folderId }));
          return { ...f, documents: [...f.documents, ...newDocs] };
        }),
      );
      selection.clear();
    },
    [selection],
  );

  const handleMergeIntoFolder = useCallback(
    (sources: DocumentListDocument[], target: DocumentListDocument) => {
      if (target.folderId) return;
      const filtered = sources.filter((s) => s.id !== target.id && !s.folderId);
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
    selection.clear();
  }, [pendingMerge, newFolderName, selection]);

  const createManualFolder = useCallback(() => {
    const name = newFolderName.trim() || `New Folder`;
    const folderId = `folder-${Date.now()}`;
    setFolders((prev) => [...prev, { id: folderId, name, documents: [] }]);
    setNewFolderName('');
    setManualFolderPrompt(false);
  }, [newFolderName]);

  const handleDeleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    if (sidebarFilter === `folder:${folderId}`) setSidebarFilter('all');
  }, [sidebarFilter]);

  const toggleFolderCollapse = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // Status bar summary.
  const summary = useMemo(() => {
    const parts: string[] = [];
    if (counts.pdf) parts.push(`${counts.pdf} PDF${counts.pdf === 1 ? '' : 's'}`);
    if (counts.epub) parts.push(`${counts.epub} EPUB${counts.epub === 1 ? '' : 's'}`);
    if (counts.html) parts.push(`${counts.html} HTML${counts.html === 1 ? '' : 's'}`);
    return parts.join(' • ');
  }, [counts]);

  const totalBytes = useMemo(
    () => allDocuments.reduce((acc, d) => acc + d.size, 0),
    [allDocuments],
  );

  if (isPDFLoading || isEPUBLoading || isHTMLLoading) {
    return <DocumentListSkeleton viewMode={viewMode === 'list' ? 'list' : 'grid'} />;
  }

  if (allDocuments.length === 0) {
    return (
      <div className="w-full max-w-2xl mx-auto py-12">
        <DocumentUploader />
      </div>
    );
  }

  const fallbackViewMode: ViewMode =
    viewMode === 'columns' && isNarrow ? 'list' : viewMode;

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
          onNewFolder={() => {
            setNewFolderName('');
            setManualFolderPrompt(true);
          }}
          onToggleSidebar={() => setSidebarOpen((p) => !p)}
          isNarrow={isNarrow}
          leftSlot={brand}
          rightSlot={appActions}
        />
      }
      sidebar={
        <FinderSidebar
          filter={sidebarFilter}
          onFilterChange={setSidebarFilter}
          folders={folders}
          counts={counts}
          onDropOnFolder={handleDropOnFolder}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          topSlot={<DocumentUploader variant="compact" />}
        />
      }
      statusBar={
        <FinderStatusBar
          itemCount={allDocuments.length}
          selectedCount={selection.selectionSize}
          totalSize={totalBytes}
          summary={summary}
        />
      }
      sidebarOpen={sidebarOpen}
      onSidebarOpenChange={setSidebarOpen}
    >
      {showHint && allDocuments.length > 1 && (
        <div className="px-3 pt-3 shrink-0 bg-background">
          <div className="flex items-center justify-between bg-base border border-offbase rounded-md px-3 py-1 text-[12px]">
            <p className="text-foreground">
              Drag files onto each other to make folders. Drop into the sidebar to move.
            </p>
            <button
              type="button"
              onClick={() => setShowHint(false)}
              className="h-6 w-6 inline-flex items-center justify-center text-muted hover:text-accent hover:bg-base hover:scale-[1.02] rounded transition-all duration-200 ease-out"
              aria-label="Dismiss hint"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <DocumentUploader variant="overlay" className="flex-1 min-h-0 flex flex-col">
        {fallbackViewMode === 'icons' && (
          <IconsView
            folders={visibleFolders}
            unfolderedDocs={unfolderedDocs}
            iconSize={iconSize}
            collapsedFolders={collapsedFolders}
            onToggleCollapse={toggleFolderCollapse}
            onDeleteFolder={handleDeleteFolder}
            onDeleteDoc={(doc) =>
              setDocumentToDelete({ id: doc.id, name: doc.name, type: doc.type })
            }
            onDropOnFolder={handleDropOnFolder}
            onMergeIntoFolder={handleMergeIntoFolder}
          />
        )}
        {fallbackViewMode === 'list' && (
          <ListView
            folders={visibleFolders}
            unfolderedDocs={unfolderedDocs}
            sortBy={sortBy}
            sortDirection={sortDirection}
            onSortChange={(b, d) => {
              setSortBy(b);
              setSortDirection(d);
            }}
            collapsedFolders={collapsedFolders}
            onToggleCollapse={toggleFolderCollapse}
            onDeleteFolder={handleDeleteFolder}
            onDeleteDoc={(doc) =>
              setDocumentToDelete({ id: doc.id, name: doc.name, type: doc.type })
            }
            onDropOnFolder={handleDropOnFolder}
            onMergeIntoFolder={handleMergeIntoFolder}
          />
        )}
        {fallbackViewMode === 'columns' && (
          <ColumnsView
            folders={visibleFolders}
            unfolderedDocs={unfolderedDocs}
            onDeleteDoc={(doc) =>
              setDocumentToDelete({ id: doc.id, name: doc.name, type: doc.type })
            }
            onDropOnFolder={handleDropOnFolder}
            onMergeIntoFolder={handleMergeIntoFolder}
          />
        )}
        {fallbackViewMode === 'gallery' && (
          <GalleryView
            folders={visibleFolders}
            unfolderedDocs={unfolderedDocs}
            onDeleteDoc={(doc) =>
              setDocumentToDelete({ id: doc.id, name: doc.name, type: doc.type })
            }
            onDropOnFolder={handleDropOnFolder}
            onMergeIntoFolder={handleMergeIntoFolder}
          />
        )}
      </DocumentUploader>

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
