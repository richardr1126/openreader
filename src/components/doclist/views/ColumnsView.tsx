'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import type { DocumentListDocument, Folder } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { FolderIcon, ChevronRightSmall } from '../window/finderIcons';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

interface ColumnsViewProps {
  folders: Folder[];
  unfolderedDocs: DocumentListDocument[];
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

type Selected =
  | { kind: 'folder'; id: string }
  | { kind: 'doc'; doc: DocumentListDocument }
  | null;

function KindIcon({ doc }: { doc: DocumentListDocument }) {
  if (doc.type === 'pdf') return <PDFIcon className="w-4 h-4 text-red-500" />;
  if (doc.type === 'epub') return <EPUBIcon className="w-4 h-4 text-blue-500" />;
  return <FileIcon className="w-4 h-4 text-muted" />;
}

function ColumnDocRow({
  doc,
  active,
  onClick,
  onMergeIntoFolder,
}: {
  doc: DocumentListDocument;
  active: boolean;
  onClick: () => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}) {
  const selection = useDocumentSelection();
  const isSelected = selection.isSelected(doc);
  const isInFolder = Boolean(doc.folderId);

  const [{ isDragging }, dragRef] = useDrag<DocumentDragItem, void, { isDragging: boolean }>(() => ({
    type: DND_DOCUMENT,
    item: () => {
      const sel = selection.getSelectedDocs();
      const dragging = isSelected && sel.length > 1 ? sel : [doc];
      if (!isSelected) selection.replace([doc]);
      return { ids: dragging.map((d) => d.id), docs: dragging, fromFolderId: doc.folderId };
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

  return (
    <div
      ref={setRefs}
      data-doc-tile
      onClick={onClick}
      className={
        'flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] transition-colors duration-200 ease-out cursor-pointer ' +
        (active || isSelected
          ? 'bg-accent text-background'
          : 'text-foreground hover:bg-offbase') +
        (isOver && canDrop ? ' ring-1 ring-accent' : '') +
        (isDragging ? ' opacity-50' : '')
      }
    >
      <KindIcon doc={doc} />
      <span className="truncate flex-1">{doc.name}</span>
    </div>
  );
}

function ColumnFolderRow({
  folder,
  active,
  onClick,
  onDropOnFolder,
}: {
  folder: Folder;
  active: boolean;
  onClick: () => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop<DocumentDragItem, void, { isOver: boolean; canDrop: boolean }>(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => item.docs.some((d) => d.folderId !== folder.id),
    drop: (item) => onDropOnFolder(folder.id, item),
    collect: (m) => ({ isOver: m.isOver({ shallow: true }), canDrop: m.canDrop() }),
  }), [folder.id, onDropOnFolder]);

  return (
    <div
      ref={dropRef as unknown as React.RefObject<HTMLDivElement>}
      onClick={onClick}
      className={
        'flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] transition-colors duration-200 ease-out cursor-pointer ' +
        (active
          ? 'bg-accent text-background'
          : 'text-foreground hover:bg-offbase') +
        (isOver && canDrop ? ' ring-1 ring-accent' : '')
      }
    >
      <FolderIcon className={'w-4 h-4 ' + (active ? 'text-background' : 'text-accent')} />
      <span className="truncate flex-1">{folder.name}</span>
      <span className={'text-[10px] ' + (active ? 'text-background' : 'text-muted')}>
        {folder.documents.length}
      </span>
      <ChevronRightSmall className={'w-3 h-3 ' + (active ? 'text-background' : 'text-muted')} />
    </div>
  );
}

function Column({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="w-[260px] shrink-0 h-full bg-base border-r border-offbase overflow-y-auto">
      {title && (
        <div className="sticky top-0 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted bg-base border-b border-offbase">
          {title}
        </div>
      )}
      <div className="p-1.5 flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function ColumnsView({
  folders,
  unfolderedDocs,
  onDeleteDoc,
  onDropOnFolder,
  onMergeIntoFolder,
}: ColumnsViewProps) {
  const { setVisibleOrder } = useDocumentSelection();
  const [selected, setSelected] = useState<Selected>(null);

  useEffect(() => {
    const all = [...folders.flatMap((f) => f.documents), ...unfolderedDocs];
    setVisibleOrder(all);
  }, [folders, unfolderedDocs, setVisibleOrder]);

  // Drop selection if it no longer exists.
  useEffect(() => {
    if (!selected) return;
    if (selected.kind === 'folder' && !folders.find((f) => f.id === selected.id)) {
      setSelected(null);
    }
  }, [folders, selected]);

  const selectedFolder =
    selected?.kind === 'folder' ? folders.find((f) => f.id === selected.id) : undefined;

  return (
    <div className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden">
      <Column title="Library">
        {folders.map((f) => (
          <ColumnFolderRow
            key={f.id}
            folder={f}
            active={selected?.kind === 'folder' && selected.id === f.id}
            onClick={() => setSelected({ kind: 'folder', id: f.id })}
            onDropOnFolder={onDropOnFolder}
          />
        ))}
        {unfolderedDocs.map((d) => (
          <ColumnDocRow
            key={`${d.type}-${d.id}`}
            doc={d}
            active={selected?.kind === 'doc' && selected.doc.id === d.id}
            onClick={() => setSelected({ kind: 'doc', doc: d })}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </Column>

      {selectedFolder && (
        <Column title={selectedFolder.name}>
          {selectedFolder.documents.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-muted text-center">Empty folder</p>
          )}
          {selectedFolder.documents.map((d) => (
            <ColumnDocRow
              key={`${d.type}-${d.id}`}
              doc={d}
              active={selected?.kind === 'doc' && selected.doc.id === d.id}
              onClick={() => setSelected({ kind: 'doc', doc: d })}
              onMergeIntoFolder={onMergeIntoFolder}
            />
          ))}
        </Column>
      )}

      {selected?.kind === 'doc' && (
        <div className="flex-1 min-w-[280px] h-full bg-background overflow-y-auto p-4">
          <div className="max-w-[360px] mx-auto">
            <div className="rounded-lg overflow-hidden border border-offbase">
              <DocumentPreview doc={selected.doc} />
            </div>
            <h3 className="mt-3 text-[13px] font-semibold text-foreground truncate">
              {selected.doc.name}
            </h3>
            <p className="text-[11px] text-muted">
              {selected.doc.type.toUpperCase()} • {(selected.doc.size / 1024 / 1024).toFixed(2)} MB
            </p>
            <div className="mt-3 flex gap-2">
              <Link
                href={`/${selected.doc.type}/${encodeURIComponent(selected.doc.id)}`}
                className="flex-1 inline-flex items-center justify-center h-8 rounded-md bg-accent text-background text-[12px] font-medium hover:bg-secondary-accent hover:scale-[1.02] transition-all duration-200 ease-out"
              >
                Open
              </Link>
              <button
                type="button"
                onClick={() => onDeleteDoc(selected.doc)}
                className="h-8 px-3 rounded-md border border-offbase bg-base text-[12px] text-muted hover:text-accent hover:border-accent hover:bg-offbase hover:scale-[1.03] transition-all duration-200 ease-out"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
