'use client';

import { useEffect } from 'react';
import { useDrop } from 'react-dnd';
import { Transition } from '@headlessui/react';
import type {
  DocumentListDocument,
  Folder,
  IconSize,
} from '@/types/documents';
import { Button } from '@headlessui/react';
import { DocumentTile } from './DocumentTile';
import { FolderIcon } from '../window/finderIcons';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

interface IconsViewProps {
  folders: Folder[];
  unfolderedDocs: DocumentListDocument[];
  iconSize: IconSize;
  collapsedFolders: Set<string>;
  onToggleCollapse: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

const COLS: Record<IconSize, string> = {
  sm: 'grid-cols-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-8',
  md: 'grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6',
  lg: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
  xl: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
};

function FolderGridRow({
  folder,
  collapsed,
  onToggleCollapse,
  onDelete,
  iconSize,
  onDropOnFolder,
  onDeleteDoc,
  onMergeIntoFolder,
}: {
  folder: Folder;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onDelete: () => void;
  iconSize: IconSize;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop<
    DocumentDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => item.docs.some((d) => d.folderId !== folder.id),
    drop: (item) => onDropOnFolder(folder.id, item),
    collect: (m) => ({ isOver: m.isOver({ shallow: true }), canDrop: m.canDrop() }),
  }), [folder.id, onDropOnFolder]);

  const totalSize = folder.documents.reduce((acc, d) => acc + d.size, 0);
  const isTarget = isOver && canDrop;

  return (
    <div
      ref={dropRef as unknown as React.RefObject<HTMLDivElement>}
      className={
        'col-span-full rounded-md border border-offbase overflow-hidden bg-base ' +
        (isTarget ? 'ring-1 ring-accent' : '')
      }
    >
      <div className="flex items-center justify-between px-2 py-1 bg-offbase border-b border-offbase">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground hover:text-accent transition-colors duration-200 ease-out"
          aria-expanded={!collapsed}
        >
          <FolderIcon className="w-3.5 h-3.5 text-accent" />
          {folder.name}
          <span className="text-[10px] font-normal text-muted ml-1">
            {folder.documents.length} • {(totalSize / 1024 / 1024).toFixed(1)} MB
          </span>
          <svg
            className={`w-3 h-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <Button
          onClick={onDelete}
          className="p-1 text-muted hover:text-accent hover:bg-base hover:scale-[1.02] rounded-md transition-all duration-200 ease-out"
          aria-label={`Delete ${folder.name}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </Button>
      </div>
      <Transition
        show={!collapsed}
        enter="transition-all duration-200 ease-out"
        enterFrom="opacity-0 max-h-0"
        enterTo="opacity-100 max-h-[2000px]"
        leave="transition-all duration-150 ease-in"
        leaveFrom="opacity-100 max-h-[2000px]"
        leaveTo="opacity-0 max-h-0"
      >
        <div className={`grid gap-2 sm:gap-3 p-2 ${COLS[iconSize]}`}>
          {folder.documents.map((doc) => (
            <DocumentTile
              key={`${doc.type}-${doc.id}`}
              doc={doc}
              iconSize={iconSize}
              onDelete={onDeleteDoc}
              onMergeIntoFolder={onMergeIntoFolder}
            />
          ))}
        </div>
      </Transition>
    </div>
  );
}

export function IconsView({
  folders,
  unfolderedDocs,
  iconSize,
  collapsedFolders,
  onToggleCollapse,
  onDeleteFolder,
  onDeleteDoc,
  onDropOnFolder,
  onMergeIntoFolder,
}: IconsViewProps) {
  const { setVisibleOrder, clear } = useDocumentSelection();

  useEffect(() => {
    const all: DocumentListDocument[] = [
      ...folders.flatMap((f) => f.documents),
      ...unfolderedDocs,
    ];
    setVisibleOrder(all);
  }, [folders, unfolderedDocs, setVisibleOrder]);

  const handleBackgroundClick: React.MouseEventHandler = (e) => {
    if ((e.target as HTMLElement).closest('[data-doc-tile]')) return;
    clear();
  };

  return (
    <div
      onClick={handleBackgroundClick}
      className="flex-1 min-h-0 overflow-y-auto p-3"
    >
      <div className={`grid gap-2 sm:gap-3 ${COLS[iconSize]}`}>
        {folders.map((folder) => (
          <FolderGridRow
            key={folder.id}
            folder={folder}
            collapsed={collapsedFolders.has(folder.id)}
            onToggleCollapse={() => onToggleCollapse(folder.id)}
            onDelete={() => onDeleteFolder(folder.id)}
            iconSize={iconSize}
            onDropOnFolder={onDropOnFolder}
            onDeleteDoc={onDeleteDoc}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
        {unfolderedDocs.map((doc) => (
          <DocumentTile
            key={`${doc.type}-${doc.id}`}
            doc={doc}
            iconSize={iconSize}
            onDelete={onDeleteDoc}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </div>
    </div>
  );
}
