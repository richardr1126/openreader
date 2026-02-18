'use client';

import { useCallback, useState, useEffect, DragEvent, KeyboardEvent } from 'react';
import { useDocuments } from '@/contexts/DocumentContext';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { DocumentType, DocumentListDocument, Folder, DocumentListState, SortBy, SortDirection } from '@/types/documents';
import { getDocumentListState, saveDocumentListState } from '@/lib/dexie';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DocumentListItem } from '@/components/doclist/DocumentListItem';
import { DocumentFolder } from '@/components/doclist/DocumentFolder';
import { SortControls } from '@/components/doclist/SortControls';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { Button } from '@headlessui/react';
import { DocumentUploader } from '@/components/documents/DocumentUploader';

type DocumentToDelete = {
  id: string;
  name: string;
  type: DocumentType;
};

const generateDefaultFolderName = (doc1: DocumentListDocument, doc2: DocumentListDocument) => {
  // Try to find common words between the two document names
  const words1 = doc1.name.toLowerCase().split(/[\s-_\.]+/);
  const words2 = doc2.name.toLowerCase().split(/[\s-_\.]+/);
  const commonWords = words1.filter(word => words2.includes(word));

  if (commonWords.length > 0) {
    // Use the first common word that's at least 3 characters long
    const significant = commonWords.find(word => word.length >= 3);
    if (significant) {
      if (significant === 'pdf') return 'PDFs';
      if (significant === 'epub') return 'EPUBs';
      if (significant === 'txt' || significant === 'md') return 'Documents';
      return `${significant.charAt(0).toUpperCase()}${significant.slice(1)}`;
    }
  }

  // Fallback to a numbered folder
  const timestamp = new Date().toISOString().slice(0, 10);
  return `Folder ${timestamp}`;
};

export function DocumentList() {
  // State hooks
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [documentToDelete, setDocumentToDelete] = useState<DocumentToDelete | null>(null);
  const [draggedDoc, setDraggedDoc] = useState<DocumentListDocument | null>(null);
  const [dropTargetDoc, setDropTargetDoc] = useState<DocumentListDocument | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [pendingFolderDocs, setPendingFolderDocs] = useState<{ source: DocumentListDocument, target: DocumentListDocument } | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [isInitialized, setIsInitialized] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');

  const {
    pdfDocs,
    removePDFDocument: removePDF,
    isPDFLoading,
    epubDocs,
    removeEPUBDocument: removeEPUB,
    isEPUBLoading,
    htmlDocs,
    removeHTMLDocument: removeHTML,
    isHTMLLoading,
  } = useDocuments();

  useEffect(() => {
    // Load saved state
    const loadState = async () => {
      const savedState = await getDocumentListState();
      if (savedState) {
        setSortBy(savedState.sortBy);
        setSortDirection(savedState.sortDirection);
        setFolders(savedState.folders);
        setCollapsedFolders(new Set(savedState.collapsedFolders));
        setShowHint(savedState.showHint ?? true); // Use saved hint state or default to true
        setViewMode(savedState.viewMode ?? 'grid');
      }
      setIsInitialized(true);
    };

    loadState();
  }, []);

  useEffect(() => {
    const saveState = async () => {
      const state: DocumentListState = {
        sortBy,
        sortDirection,
        folders,
        collapsedFolders: Array.from(collapsedFolders),
        showHint,
        viewMode
      };
      await saveDocumentListState(state);
    };

    if (isInitialized) { // Prevents saving empty state on first render or back navigation
      saveState();
    }
  }, [sortBy, sortDirection, folders, collapsedFolders, showHint, viewMode, isInitialized]);

  // Reconcile folder state against the current server-backed document list.
  // If a document no longer exists on the server, drop it from folders to avoid stale UI.
  useEffect(() => {
    if (!isInitialized) return;
    const ids = new Set<string>([...pdfDocs, ...epubDocs, ...htmlDocs].map((d) => d.id));
    setFolders((prev) =>
      prev.map((folder) => ({
        ...folder,
        documents: folder.documents.filter((d) => ids.has(d.id)),
      })),
    );
  }, [isInitialized, pdfDocs, epubDocs, htmlDocs]);

  const allDocuments: DocumentListDocument[] = [
    ...pdfDocs.map((doc) => ({ ...doc, type: 'pdf' as const })),
    ...epubDocs.map((doc) => ({ ...doc, type: 'epub' as const })),
    ...htmlDocs.map((doc) => ({ ...doc, type: 'html' as const })),
  ];

  const sortDocuments = useCallback((docs: DocumentListDocument[]) => {
    return [...docs].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return sortDirection === 'asc'
            ? a.name.localeCompare(b.name)
            : b.name.localeCompare(a.name);
        case 'type':
          return sortDirection === 'asc'
            ? a.type.localeCompare(b.type)
            : b.type.localeCompare(a.type);
        case 'size':
          return sortDirection === 'asc'
            ? a.size - b.size
            : b.size - a.size;
        default:
          return sortDirection === 'asc'
            ? a.lastModified - b.lastModified
            : b.lastModified - a.lastModified;
      }
    });
  }, [sortBy, sortDirection]);

  const handleDelete = useCallback(async () => {
    if (!documentToDelete) return;

    try {
      if (documentToDelete.type === 'pdf') {
        await removePDF(documentToDelete.id);
      } else if (documentToDelete.type === 'epub') {
        await removeEPUB(documentToDelete.id);
      } else if (documentToDelete.type === 'html') {
        await removeHTML(documentToDelete.id);
      }

      // Remove from folders if document is in one
      setFolders(prev => prev.map(folder => ({
        ...folder,
        documents: folder.documents.filter(doc =>
          !(doc.id === documentToDelete.id && doc.type === documentToDelete.type)
        )
      })));

      setDocumentToDelete(null);
    } catch (err) {
      console.error('Failed to remove document:', err);
    }
  }, [documentToDelete, removePDF, removeEPUB, removeHTML]);

  const handleDragStart = useCallback((doc: DocumentListDocument) => {
    if (!doc.folderId) {
      setDraggedDoc(doc);
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedDoc(null);
    setDropTargetDoc(null);
  }, []);

  const handleDragOver = useCallback((e: DragEvent, doc: DocumentListDocument) => {
    e.preventDefault();
    if (draggedDoc && draggedDoc.id !== doc.id && !draggedDoc.folderId) {
      // Only highlight target if neither document is in a folder
      if (!doc.folderId) {
        setDropTargetDoc(doc);
      }
    }
  }, [draggedDoc]);

  const handleDragLeave = useCallback(() => {
    setDropTargetDoc(null);
  }, []);

  const handleDrop = useCallback((e: DragEvent, targetDoc: DocumentListDocument) => {
    e.preventDefault();
    console.log('Dropped', draggedDoc?.name, 'on', targetDoc.name);

    if (!draggedDoc || draggedDoc.id === targetDoc.id || draggedDoc.folderId) return;

    // If target doc is unfoldered, create a new folder
    if (!targetDoc.folderId) {
      setPendingFolderDocs({
        source: draggedDoc,
        target: targetDoc
      });
      setNewFolderName('');
    }

    setDraggedDoc(null);
    setDropTargetDoc(null);
  }, [draggedDoc]);

  const handleFolderDrop = useCallback((e: DragEvent, folderId: string) => {
    e.preventDefault();
    if (!draggedDoc || draggedDoc.folderId) return;

    // Add document to existing folder
    setFolders(folders.map(f => {
      if (f.id === folderId && !f.documents.some(d => d.id === draggedDoc.id)) {
        return {
          ...f,
          documents: [...f.documents, { ...draggedDoc, folderId }]
        };
      }
      return f;
    }));

    setDraggedDoc(null);
    setDropTargetDoc(null);
  }, [draggedDoc, folders]);

  const toggleFolderCollapse = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const createFolder = useCallback(() => {
    if (!pendingFolderDocs) return;

    const folderName = newFolderName.trim() ||
      generateDefaultFolderName(pendingFolderDocs.source, pendingFolderDocs.target);

    const folderId = `folder-${Date.now()}`;
    setFolders(prev => [
      ...prev,
      {
        id: folderId,
        name: folderName,
        documents: [
          { ...pendingFolderDocs.source, folderId },
          { ...pendingFolderDocs.target, folderId }
        ]
      }
    ]);

    setPendingFolderDocs(null);
    setNewFolderName('');
    setDropTargetDoc(null);
    setDraggedDoc(null);
    setShowHint(false);
  }, [pendingFolderDocs, newFolderName]);

  const handleFolderNameKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createFolder();
    } else if (e.key === 'Escape') {
      setPendingFolderDocs(null);
      setNewFolderName('');
    }
  }, [createFolder]);

  if (isPDFLoading || isEPUBLoading || isHTMLLoading) {
    return <DocumentListSkeleton viewMode={viewMode} />;
  }

  if (allDocuments.length === 0) {
    return <div className="w-full text-center text-muted">No documents uploaded yet</div>;
  }

  const unfolderedDocuments = allDocuments.filter(
    doc => !folders.some(folder => folder.documents.some(d => d.id === doc.id))
  );

  // Build compact summary (counts per type + total size)
  const summaryParts: string[] = [];
  if (pdfDocs.length) summaryParts.push(`${pdfDocs.length} PDF${pdfDocs.length === 1 ? '' : 's'}`);
  if (epubDocs.length) summaryParts.push(`${epubDocs.length} EPUB${epubDocs.length === 1 ? '' : 's'}`);
  if (htmlDocs.length) summaryParts.push(`${htmlDocs.length} HTML${htmlDocs.length === 1 ? '' : 's'}`);
  const totalSizeMB = (allDocuments.reduce((acc, d) => acc + d.size, 0) / 1024 / 1024).toFixed(2);

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="w-full mx-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg sm:text-xl font-semibold text-foreground">Local Documents</h2>
          <SortControls
            sortBy={sortBy}
            sortDirection={sortDirection}
            onSortByChange={setSortBy}
            onSortDirectionChange={() => setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </div>

        <p className="text-xs text-muted mb-2" data-doc-summary>
          {summaryParts.join(' • ')}{summaryParts.length ? ' • ' : ''}{totalSizeMB} MB total
        </p>
        <div className="mb-3">
          <DocumentUploader variant="compact" />
        </div>

        {showHint && allDocuments.length > 1 && (
          <div className="flex items-center justify-between bg-offbase border border-offbase rounded-md px-3 py-1 text-sm mb-2">
            <p className="text-sm text-foreground">Drag files on top of each other to make folders</p>
            <Button
              onClick={() => setShowHint(false)}
              className="p-1 rounded-md hover:bg-base hover:text-accent transition-colors"
              aria-label="Dismiss hint"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
        )}

        <div
          className={
            viewMode === 'grid'
              ? 'grid w-full grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5'
              : 'w-full space-y-1'
          }
        >

          {folders.map(folder => (
            <DocumentFolder
              key={folder.id}
              folder={folder}
              isCollapsed={collapsedFolders.has(folder.id)}
              onToggleCollapse={toggleFolderCollapse}
              onDelete={() => setFolders(prev => prev.filter(f => f.id !== folder.id))}
              sortedDocuments={sortDocuments(folder.documents)}
              onDocumentDelete={setDocumentToDelete}
              draggedDoc={draggedDoc}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDrop={handleFolderDrop}
              viewMode={viewMode}
            />
          ))}

          {sortDocuments(unfolderedDocuments).map(doc => (
            <DocumentListItem
              key={`${doc.type}-${doc.id}`}
              doc={doc}
              onDelete={setDocumentToDelete}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              isDropTarget={dropTargetDoc?.id === doc.id}
              viewMode={viewMode}
            />
          ))}
        </div>

        <CreateFolderDialog
          isOpen={pendingFolderDocs !== null}
          onClose={() => setPendingFolderDocs(null)}
          folderName={newFolderName}
          onFolderNameChange={setNewFolderName}
          onKeyDown={handleFolderNameKeyDown}
        />

        <ConfirmDialog
          isOpen={documentToDelete !== null}
          onClose={() => setDocumentToDelete(null)}
          onConfirm={handleDelete}
          title="Delete Document"
          message={`Are you sure you want to delete ${documentToDelete?.name || 'this document'}?`}
          confirmText="Delete"
          isDangerous={true}
        />
      </div>
    </DndProvider>
  );
}
