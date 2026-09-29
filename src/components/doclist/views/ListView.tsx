'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import type {
  DocumentListDocument,
  SortBy,
  SortDirection,
} from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { formatDocumentSize } from '@/components/doclist/formatSize';
import { DocumentActionsMenu } from '../DocumentActionsMenu';
import type { DocumentActions } from '../document-actions';
import { SelectCheck } from '../SelectCheck';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, documentIdentityKey, type DocumentDragItem } from '../dnd/dndTypes';

interface ListViewProps {
  documents: DocumentListDocument[];
  sortBy: SortBy;
  sortDirection: SortDirection;
  onSortChange: (sortBy: SortBy, direction: SortDirection) => void;
  actions: DocumentActions;
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
  actions,
  onMergeIntoFolder,
}: {
  doc: DocumentListDocument;
  actions: DocumentActions;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}) {
  const selection = useDocumentSelection();
  const isSelected = selection.isSelected(doc);
  const isInFolder = Boolean(doc.folderId);
  const href = `/${doc.type}/${encodeURIComponent(doc.id)}`;
  const didDragRef = useRef(false);

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
    // A mouse drag ending on the same row is followed by a click that would open
    // the doc. Flag the drag so handleClick can swallow that click; clear on the
    // next macrotask in case the drag ended elsewhere (no click fires).
    end: () => {
      didDragRef.current = true;
      setTimeout(() => { didDragRef.current = false; }, 0);
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
    if (didDragRef.current) {
      didDragRef.current = false;
      e.preventDefault();
      return;
    }
    // While anything is selected a plain click keeps selecting instead of opening.
    if (e.shiftKey || e.metaKey || e.ctrlKey || selection.selectionSize > 0) {
      e.preventDefault();
      selection.select(doc, { shift: e.shiftKey, meta: !e.shiftKey });
    }
  };

  return (
    <div
      ref={setRefs}
      data-doc-tile
      aria-selected={isSelected}
      className={
        'group grid grid-cols-[28px_minmax(0,1fr)_44px_72px_104px_28px] sm:grid-cols-[28px_minmax(0,1fr)_56px_96px_140px_32px] items-center text-[12px] border-b border-line-soft transition-colors duration-base ease-standard ' +
        // iOS: suppress the long-press link preview/callout and selection magnifier so the
        // long-press is handed to the touch DnD backend instead of the native preview.
        'select-none [-webkit-touch-callout:none] ' +
        (isSelected
          ? 'bg-surface-sunken text-accent'
          : 'text-foreground hover:bg-accent-wash') +
        (isTarget ? ' ring-1 ring-accent-line ring-inset' : '') +
        (isDragging ? ' opacity-50' : '')
      }
    >
      <span className="flex justify-center">
        <SelectCheck
          checked={isSelected}
          selectionActive={selection.selectionSize > 0}
          label={`Select ${doc.name}`}
          onToggle={() => selection.toggle(doc)}
        />
      </span>
      <Link
        href={href}
        prefetch={false}
        draggable={false}
        onClick={handleClick}
        className="flex items-center gap-2 min-w-0 py-1.5 pr-2"
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
      <DocumentActionsMenu doc={doc} actions={actions} />
    </div>
  );
}

export function ListView({
  documents,
  sortBy,
  sortDirection,
  onSortChange,
  actions,
  onMergeIntoFolder,
}: ListViewProps) {
  const { setVisibleOrder, clear, selectAll, selectionSize } = useDocumentSelection();
  const allSelected = documents.length > 0 && selectionSize === documents.length;

  useEffect(() => {
    setVisibleOrder(documents);
  }, [documents, setVisibleOrder]);

  const handleBackgroundClick: React.MouseEventHandler = (e) => {
    if ((e.target as HTMLElement).closest('[data-doc-tile]')) return;
    clear();
  };

  return (
    <div onClick={handleBackgroundClick} className="flex-1 min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 bg-surface border-b border-line-soft grid grid-cols-[28px_minmax(0,1fr)_44px_72px_104px_28px] sm:grid-cols-[28px_minmax(0,1fr)_56px_96px_140px_32px]">
        <span className="flex items-center justify-center">
          <SelectCheck
            checked={allSelected}
            selectionActive
            label={allSelected ? 'Deselect all documents' : 'Select all documents'}
            onToggle={allSelected ? clear : selectAll}
          />
        </span>
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
            actions={actions}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </div>
    </div>
  );
}
