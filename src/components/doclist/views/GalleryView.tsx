'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import type { DocumentListDocument, Folder } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { FolderIcon } from '../window/finderIcons';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

interface GalleryViewProps {
  folders: Folder[];
  unfolderedDocs: DocumentListDocument[];
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onDropOnFolder: (folderId: string, item: DocumentDragItem) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

function KindIcon({ doc, className }: { doc: DocumentListDocument; className?: string }) {
  if (doc.type === 'pdf') return <PDFIcon className={className ?? 'w-4 h-4 text-red-500'} />;
  if (doc.type === 'epub') return <EPUBIcon className={className ?? 'w-4 h-4 text-blue-500'} />;
  return <FileIcon className={className ?? 'w-4 h-4 text-muted'} />;
}

function GalleryThumb({
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
        'shrink-0 cursor-pointer rounded-md overflow-hidden border transition-all duration-200 ease-out snap-start ' +
        (active
          ? 'border-accent ring-1 ring-accent w-[110px]'
          : 'border-offbase hover:border-accent hover:scale-[1.01] w-[88px]') +
        (isOver && canDrop ? ' ring-1 ring-accent' : '') +
        (isDragging ? ' opacity-50' : '')
      }
      title={doc.name}
    >
      <div className="aspect-[3/4] bg-base">
        <DocumentPreview doc={doc} />
      </div>
      <div className="px-1.5 py-1 flex items-center gap-1 bg-base">
        <KindIcon doc={doc} className="w-3 h-3 shrink-0 text-muted" />
        <span className="truncate text-[10px] text-foreground">{doc.name}</span>
      </div>
    </div>
  );
}

function GalleryFolderThumb({
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
        'shrink-0 cursor-pointer rounded-md overflow-hidden border transition-all duration-200 ease-out snap-start flex flex-col items-center justify-center gap-2 ' +
        (active
          ? 'border-accent ring-1 ring-accent w-[110px]'
          : 'border-offbase hover:border-accent hover:scale-[1.01] w-[88px]') +
        (isOver && canDrop ? ' ring-1 ring-accent' : '')
      }
    >
      <div className="aspect-[3/4] w-full bg-base flex items-center justify-center">
        <FolderIcon className="w-10 h-10 text-accent" />
      </div>
      <div className="px-1.5 py-1 w-full text-center bg-base">
        <span className="text-[10px] text-foreground truncate block">{folder.name}</span>
        <span className="text-[9px] text-muted">{folder.documents.length} items</span>
      </div>
    </div>
  );
}

export function GalleryView({
  folders,
  unfolderedDocs,
  onDeleteDoc,
  onDropOnFolder,
  onMergeIntoFolder,
}: GalleryViewProps) {
  const { setVisibleOrder } = useDocumentSelection();
  const allDocs = useMemo(
    () => [...folders.flatMap((f) => f.documents), ...unfolderedDocs],
    [folders, unfolderedDocs],
  );
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    setVisibleOrder(allDocs);
  }, [allDocs, setVisibleOrder]);

  useEffect(() => {
    if (activeIdx >= allDocs.length) setActiveIdx(Math.max(0, allDocs.length - 1));
  }, [allDocs.length, activeIdx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowRight') {
        setActiveIdx((i) => Math.min(allDocs.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        setActiveIdx((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allDocs.length]);

  const activeDoc = allDocs[activeIdx];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 flex items-center justify-center p-6 bg-background">
        {activeDoc ? (
          <div className="flex flex-col items-center gap-3 max-w-[420px]">
            <div className="w-[260px] sm:w-[320px] aspect-[3/4] rounded-lg overflow-hidden border border-offbase shadow-lg">
              <DocumentPreview doc={activeDoc} />
            </div>
            <div className="text-center">
              <h2 className="text-[14px] font-semibold text-foreground truncate max-w-[320px]">
                {activeDoc.name}
              </h2>
              <p className="text-[11px] text-muted">
                {activeDoc.type.toUpperCase()} •{' '}
                {activeDoc.size >= 1024 * 1024 * 1024
                  ? `${(activeDoc.size / 1024 / 1024 / 1024).toFixed(2)} GB`
                  : activeDoc.size >= 1024 * 1024
                    ? `${(activeDoc.size / 1024 / 1024).toFixed(2)} MB`
                    : `${(activeDoc.size / 1024).toFixed(1)} KB`}
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href={`/${activeDoc.type}/${encodeURIComponent(activeDoc.id)}`}
                className="h-8 px-4 inline-flex items-center justify-center rounded-md bg-accent text-background text-[12px] font-medium hover:bg-secondary-accent hover:scale-[1.02] transition-all duration-200 ease-out"
              >
                Open
              </Link>
              <button
                type="button"
                onClick={() => onDeleteDoc(activeDoc)}
                className="h-8 px-3 rounded-md border border-offbase bg-base text-[12px] text-muted hover:text-accent hover:border-accent hover:bg-offbase hover:scale-[1.02] transition-all duration-200 ease-out"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-muted">No documents to show</p>
        )}
      </div>

      <div className="shrink-0 border-t border-offbase bg-base">
        <div className="flex gap-2 overflow-x-auto p-2 snap-x snap-mandatory">
          {folders.map((f) => (
            <GalleryFolderThumb
              key={f.id}
              folder={f}
              active={false}
              onClick={() => { /* could expand later */ }}
              onDropOnFolder={onDropOnFolder}
            />
          ))}
          {allDocs.map((doc, i) => (
            <GalleryThumb
              key={`${doc.type}-${doc.id}`}
              doc={doc}
              active={i === activeIdx}
              onClick={() => setActiveIdx(i)}
              onMergeIntoFolder={onMergeIntoFolder}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
