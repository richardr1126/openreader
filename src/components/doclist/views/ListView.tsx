'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Button, Transition } from '@headlessui/react';
import type {
  DocumentListDocument,
  Folder,
  SortBy,
  SortDirection,
} from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { FolderIcon } from '../window/finderIcons';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

interface ListViewProps {
  folders: Folder[];
  unfolderedDocs: DocumentListDocument[];
  sortBy: SortBy;
  sortDirection: SortDirection;
  onSortChange: (sortBy: SortBy, direction: SortDirection) => void;
  collapsedFolders: Set<string>;
  onToggleCollapse: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function KindIcon({ doc }: { doc: DocumentListDocument }) {
  if (doc.type === 'pdf') return <PDFIcon className="w-4 h-4 text-red-500" />;
  if (doc.type === 'epub') return <EPUBIcon className="w-4 h-4 text-blue-500" />;
  return <FileIcon className="w-4 h-4 text-muted" />;
}

function HeaderCell({
  label,
  field,
  sortBy,
  sortDirection,
  onSortChange,
  className,
  align = 'left',
}: {
  label: string;
  field: SortBy;
  sortBy: SortBy;
  sortDirection: SortDirection;
  onSortChange: (b: SortBy, d: SortDirection) => void;
  className?: string;
  align?: 'left' | 'right';
}) {
  const active = sortBy === field;
  const arrow = active ? (sortDirection === 'asc' ? '↑' : '↓') : '';
  return (
    <button
      type="button"
      onClick={() => {
        const nextDir: SortDirection =
          active && sortDirection === 'asc' ? 'desc' : 'asc';
        onSortChange(field, nextDir);
      }}
      className={
        'flex items-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide font-semibold transition-colors duration-200 ease-out hover:text-accent ' +
        (active ? 'text-accent' : 'text-muted') +
        (align === 'right' ? ' justify-end' : '') +
        ' ' +
        (className ?? '')
      }
    >
      <span>{label}</span>
      <span className="w-2 text-[10px]">{arrow}</span>
    </button>
  );
}

function DocRow({
  doc,
  isFirstColumnIndented,
  onDeleteDoc,
  onMergeIntoFolder,
}: {
  doc: DocumentListDocument;
  isFirstColumnIndented?: boolean;
  onDeleteDoc: (d: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}) {
  const selection = useDocumentSelection();
  const isSelected = selection.isSelected(doc);
  const isInFolder = Boolean(doc.folderId);
  const [loading, setLoading] = useState(false);
  const href = `/${doc.type}/${encodeURIComponent(doc.id)}`;

  const [{ isDragging }, dragRef] = useDrag<DocumentDragItem, void, { isDragging: boolean }>(() => ({
    type: DND_DOCUMENT,
    item: () => {
      const selected = selection.getSelectedDocs();
      const dragging = isSelected && selected.length > 1 ? selected : [doc];
      if (!isSelected) selection.replace([doc]);
      return {
        ids: dragging.map((d) => d.id),
        docs: dragging,
        fromFolderId: doc.folderId,
      };
    },
    collect: (m) => ({ isDragging: m.isDragging() }),
  }), [doc, isSelected]);

  const [{ isOver, canDrop }, dropRef] = useDrop<DocumentDragItem, void, { isOver: boolean; canDrop: boolean }>(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => !isInFolder && !item.ids.includes(doc.id),
    drop: (item) => onMergeIntoFolder(item.docs, doc),
    collect: (m) => ({ isOver: m.isOver({ shallow: true }), canDrop: m.canDrop() }),
  }), [doc, isInFolder, onMergeIntoFolder]);

  const setRefs = (node: HTMLDivElement | null) => {
    dragRef(node);
    dropRef(node);
  };

  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 2500);
    return () => clearTimeout(t);
  }, [loading]);

  const isTarget = isOver && canDrop;

  const handleClick: React.MouseEventHandler = (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      selection.select(doc, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      return;
    }
    selection.replace([doc]);
    setLoading(true);
  };

  return (
    <div
      ref={setRefs}
      data-doc-tile
      aria-selected={isSelected}
      className={
        'grid grid-cols-[minmax(0,1fr)_72px_88px_120px_28px] sm:grid-cols-[minmax(0,1fr)_88px_96px_140px_32px] items-center text-[12px] border-b border-offbase transition-colors duration-200 ease-out ' +
        (isSelected
          ? 'bg-offbase text-accent'
          : 'text-foreground hover:bg-offbase') +
        (isTarget ? ' ring-1 ring-accent ring-inset' : '') +
        (isDragging ? ' opacity-50' : '') +
        (loading ? ' prism-outline' : '')
      }
    >
      <Link
        href={href}
        draggable={false}
        onClick={handleClick}
        className={
          'flex items-center gap-2 min-w-0 px-2 py-1.5 ' +
          (isFirstColumnIndented ? 'pl-8' : '')
        }
      >
        <KindIcon doc={doc} />
        <span className="truncate">{doc.name}</span>
      </Link>
      <span className="px-2 text-[11px] text-muted uppercase tracking-wide">{doc.type}</span>
      <span className="px-2 text-[11px] text-muted text-right tabular-nums">
        {formatSize(doc.size)}
      </span>
      <span className="px-2 text-[11px] text-muted tabular-nums">
        {formatDate(doc.lastModified)}
      </span>
      <Button
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onDeleteDoc(doc);
        }}
        className="h-7 w-7 flex items-center justify-center text-muted hover:text-accent hover:bg-offbase hover:scale-[1.02] rounded transition-all duration-200 ease-out"
        aria-label={`Delete ${doc.name}`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      </Button>
    </div>
  );
}

function FolderRowGroup({
  folder,
  collapsed,
  onToggleCollapse,
  onDelete,
  onDeleteDoc,
  onDropOnFolder,
  onMergeIntoFolder,
}: {
  folder: Folder;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onDelete: () => void;
  onDeleteDoc: (d: DocumentListDocument) => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop<DocumentDragItem, void, { isOver: boolean; canDrop: boolean }>(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => item.docs.some((d) => d.folderId !== folder.id),
    drop: (item) => onDropOnFolder(folder.id, item),
    collect: (m) => ({ isOver: m.isOver({ shallow: true }), canDrop: m.canDrop() }),
  }), [folder.id, onDropOnFolder]);

  const isTarget = isOver && canDrop;
  const totalSize = folder.documents.reduce((acc, d) => acc + d.size, 0);

  return (
    <div ref={dropRef as unknown as React.RefObject<HTMLDivElement>}>
      <div
        className={
          'grid grid-cols-[minmax(0,1fr)_72px_88px_120px_28px] sm:grid-cols-[minmax(0,1fr)_88px_96px_140px_32px] items-center text-[12px] border-b border-offbase bg-base ' +
          (isTarget ? 'ring-1 ring-accent ring-inset' : '')
        }
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 min-w-0 px-2 py-1.5 text-left font-semibold hover:text-accent transition-colors duration-200 ease-out"
        >
          <svg
            className={`w-3 h-3 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
          <FolderIcon className="w-3.5 h-3.5 text-accent" />
          <span className="truncate">{folder.name}</span>
        </button>
        <span className="px-2 text-[11px] text-muted">Folder</span>
        <span className="px-2 text-[11px] text-muted text-right tabular-nums">
          {formatSize(totalSize)}
        </span>
        <span className="px-2 text-[11px] text-muted tabular-nums">
          {folder.documents.length} items
        </span>
        <Button
          onClick={onDelete}
          className="h-7 w-7 flex items-center justify-center text-muted hover:text-accent hover:bg-offbase hover:scale-[1.02] rounded transition-all duration-200 ease-out"
          aria-label={`Delete ${folder.name}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </Button>
      </div>
      <Transition
        show={!collapsed}
        enter="transition-all duration-200"
        enterFrom="opacity-0 max-h-0"
        enterTo="opacity-100 max-h-[2000px]"
        leave="transition-all duration-150"
        leaveFrom="opacity-100 max-h-[2000px]"
        leaveTo="opacity-0 max-h-0"
      >
        <div>
          {folder.documents.map((doc) => (
            <DocRow
              key={`${doc.type}-${doc.id}`}
              doc={doc}
              isFirstColumnIndented
              onDeleteDoc={onDeleteDoc}
              onMergeIntoFolder={onMergeIntoFolder}
            />
          ))}
        </div>
      </Transition>
    </div>
  );
}

export function ListView({
  folders,
  unfolderedDocs,
  sortBy,
  sortDirection,
  onSortChange,
  collapsedFolders,
  onToggleCollapse,
  onDeleteFolder,
  onDeleteDoc,
  onDropOnFolder,
  onMergeIntoFolder,
}: ListViewProps) {
  const { setVisibleOrder, clear } = useDocumentSelection();

  useEffect(() => {
    const all = [...folders.flatMap((f) => f.documents), ...unfolderedDocs];
    setVisibleOrder(all);
  }, [folders, unfolderedDocs, setVisibleOrder]);

  const handleBackgroundClick: React.MouseEventHandler = (e) => {
    if ((e.target as HTMLElement).closest('[data-doc-tile]')) return;
    clear();
  };

  return (
    <div onClick={handleBackgroundClick} className="flex-1 min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 bg-base border-b border-offbase grid grid-cols-[minmax(0,1fr)_72px_88px_120px_28px] sm:grid-cols-[minmax(0,1fr)_88px_96px_140px_32px]">
        <HeaderCell label="Name" field="name" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} />
        <HeaderCell label="Kind" field="type" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} />
        <HeaderCell label="Size" field="size" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} align="right" />
        <HeaderCell label="Modified" field="date" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} />
        <span />
      </div>
      <div>
        {folders.map((folder) => (
          <FolderRowGroup
            key={folder.id}
            folder={folder}
            collapsed={collapsedFolders.has(folder.id)}
            onToggleCollapse={() => onToggleCollapse(folder.id)}
            onDelete={() => onDeleteFolder(folder.id)}
            onDeleteDoc={onDeleteDoc}
            onDropOnFolder={onDropOnFolder}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
        {unfolderedDocs.map((doc) => (
          <DocRow
            key={`${doc.type}-${doc.id}`}
            doc={doc}
            onDeleteDoc={onDeleteDoc}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </div>
    </div>
  );
}
