'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import type {
  DocumentListDocument,
  SortBy,
  SortDirection,
} from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { formatDocumentSize } from '@/components/doclist/formatSize';
import { IconButton } from '@/components/ui';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, documentIdentityKey, type DocumentDragItem } from '../dnd/dndTypes';

interface ListViewProps {
  documents: DocumentListDocument[];
  sortBy: SortBy;
  sortDirection: SortDirection;
  onSortChange: (sortBy: SortBy, direction: SortDirection) => void;
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function KindIcon({ doc }: { doc: DocumentListDocument }) {
  if (doc.type === 'pdf') return <PDFIcon className="w-4 h-4 shrink-0 text-danger" />;
  if (doc.type === 'epub') return <EPUBIcon className="w-4 h-4 shrink-0 text-accent" />;
  return <FileIcon className="w-4 h-4 shrink-0 text-soft" />;
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
        'flex items-center gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide font-semibold transition-colors duration-base ease-standard hover:text-accent ' +
        (active ? 'text-accent' : 'text-soft') +
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
  onDeleteDoc,
  onMergeIntoFolder,
}: {
  doc: DocumentListDocument;
  onDeleteDoc: (d: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}) {
  const selection = useDocumentSelection();
  const isSelected = selection.isSelected(doc);
  const isInFolder = Boolean(doc.folderId);
  const href = `/${doc.type}/${encodeURIComponent(doc.id)}`;

  const [{ isDragging }, dragRef] = useDrag<DocumentDragItem, void, { isDragging: boolean }>(() => ({
    type: DND_DOCUMENT,
    item: () => {
      const selected = selection.getSelectedDocs();
      const dragging = isSelected && selected.length > 1 ? selected : [doc];
      if (!isSelected) selection.replace([doc]);
      return {
        items: dragging.map(({ id, type }) => ({ id, type })),
        docs: dragging,
        fromFolderId: doc.folderId,
      };
    },
    collect: (m) => ({ isDragging: m.isDragging() }),
  }), [doc, isSelected, selection]);

  const [{ isOver, canDrop }, dropRef] = useDrop<DocumentDragItem, void, { isOver: boolean; canDrop: boolean }>(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => !isInFolder && !item.items.some((it) => documentIdentityKey(it) === documentIdentityKey(doc)),
    drop: (item) => onMergeIntoFolder(item.docs, doc),
    collect: (m) => ({ isOver: m.isOver({ shallow: true }), canDrop: m.canDrop() }),
  }), [doc, isInFolder, onMergeIntoFolder]);

  const setRefs = (node: HTMLDivElement | null) => {
    dragRef(node);
    dropRef(node);
  };

  const isTarget = isOver && canDrop;

  const handleClick: React.MouseEventHandler = (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      selection.select(doc, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
    }
  };

  return (
    <div
      ref={setRefs}
      data-doc-tile
      aria-selected={isSelected}
      className={
        'grid grid-cols-[minmax(0,1fr)_44px_72px_104px_28px] sm:grid-cols-[minmax(0,1fr)_56px_96px_140px_32px] items-center text-[12px] border-b border-line-soft transition-colors duration-base ease-standard ' +
        (isSelected
          ? 'bg-surface-sunken text-accent'
          : 'text-foreground hover:bg-accent-wash') +
        (isTarget ? ' ring-1 ring-accent-line ring-inset' : '') +
        (isDragging ? ' opacity-50' : '')
      }
    >
      <Link
        href={href}
        prefetch={false}
        draggable={false}
        onClick={handleClick}
        className="flex items-center gap-2 min-w-0 px-2 py-1.5"
      >
        <KindIcon doc={doc} />
        <span className="truncate">{doc.name}</span>
      </Link>
      <span className="px-2 text-[11px] text-soft uppercase tracking-wide">{doc.type}</span>
      <span className="px-2 text-[11px] text-soft text-right tabular-nums">
        {formatDocumentSize(doc.size)}
      </span>
      <span className="px-2 text-[11px] text-soft tabular-nums">
        {formatDate(doc.lastModified)}
      </span>
      <IconButton
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onDeleteDoc(doc);
        }}
        size="sm"
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
      </IconButton>
    </div>
  );
}

export function ListView({
  documents,
  sortBy,
  sortDirection,
  onSortChange,
  onDeleteDoc,
  onMergeIntoFolder,
}: ListViewProps) {
  const { setVisibleOrder, clear } = useDocumentSelection();

  useEffect(() => {
    setVisibleOrder(documents);
  }, [documents, setVisibleOrder]);

  const handleBackgroundClick: React.MouseEventHandler = (e) => {
    if ((e.target as HTMLElement).closest('[data-doc-tile]')) return;
    clear();
  };

  return (
    <div onClick={handleBackgroundClick} className="flex-1 min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 bg-surface border-b border-line-soft grid grid-cols-[minmax(0,1fr)_44px_72px_104px_28px] sm:grid-cols-[minmax(0,1fr)_56px_96px_140px_32px]">
        <HeaderCell label="Name" field="name" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} />
        <HeaderCell label="Kind" field="type" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} />
        <HeaderCell label="Size" field="size" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} align="right" />
        <HeaderCell label="Modified" field="date" sortBy={sortBy} sortDirection={sortDirection} onSortChange={onSortChange} />
        <span />
      </div>
      <div>
        {documents.map((doc) => (
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
