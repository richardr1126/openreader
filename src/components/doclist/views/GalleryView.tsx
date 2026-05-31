'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import type { DocumentListDocument } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { formatDocumentSize } from '@/components/doclist/formatSize';
import { buttonClass } from '@/components/formPrimitives';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, documentIdentityKey, type DocumentDragItem } from '../dnd/dndTypes';

interface GalleryViewProps {
  documents: DocumentListDocument[];
  folderNameById?: Record<string, string>;
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

function formatDateTime(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return 'Never';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatParseStatus(status: DocumentListDocument['parseStatus']): string {
  if (!status) return 'N/A';
  if (status === 'pending') return 'Pending';
  if (status === 'running') return 'Running';
  if (status === 'ready') return 'Ready';
  return 'Failed';
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

  return (
    <div
      ref={setRefs}
      data-doc-tile
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={
        'group relative w-[98px] sm:w-[110px] shrink-0 cursor-pointer rounded-lg overflow-hidden border bg-base snap-start transition-all duration-200 ease-out ' +
        (active
          ? 'border-accent shadow-[0_10px_24px_-18px_rgba(0,0,0,0.85)] -translate-y-0.5'
          : 'border-offbase hover:border-accent hover:-translate-y-0.5') +
        (isOver && canDrop ? ' border-accent' : '') +
        (isDragging ? ' opacity-50' : '')
      }
      title={doc.name}
    >
      <div className="aspect-[3/4] bg-base">
        <DocumentPreview doc={doc} />
      </div>
      <div
        className={
          'px-2 py-1.5 flex items-center gap-1.5 border-t transition-colors duration-200 ' +
          (active ? 'bg-offbase border-accent' : 'bg-base border-offbase')
        }
      >
        <KindIcon
          doc={doc}
          className={
            'w-3 h-3 shrink-0 transition-colors duration-200 ' +
            (active ? 'text-accent' : 'text-muted')
          }
        />
        <span
          className={
            'truncate text-[10px] leading-none transition-colors duration-200 ' +
            (active ? 'text-accent font-medium' : 'text-foreground')
          }
        >
          {doc.name}
        </span>
      </div>
    </div>
  );
}

export function GalleryView({
  documents,
  folderNameById,
  onDeleteDoc,
  onMergeIntoFolder,
}: GalleryViewProps) {
  const { setVisibleOrder } = useDocumentSelection();
  const railRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeDoc = useMemo(() => documents[activeIdx], [documents, activeIdx]);
  const openHref = activeDoc ? `/${activeDoc.type}/${encodeURIComponent(activeDoc.id)}` : null;

  useEffect(() => {
    setVisibleOrder(documents);
  }, [documents, setVisibleOrder]);

  useEffect(() => {
    if (activeIdx >= documents.length) {
      setActiveIdx(Math.max(0, documents.length - 1));
    }
  }, [documents.length, activeIdx]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollLeft = 0;
  }, [documents.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (documents.length === 0) return;
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowRight') {
        setActiveIdx((i) => Math.min(documents.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const doc = documents[activeIdx];
        if (doc) {
          e.preventDefault();
          onDeleteDoc(doc);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [documents, activeIdx, onDeleteDoc]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto bg-background">
        <div className="min-h-full flex items-center justify-center p-3 sm:p-6">
        {activeDoc ? (
          <div className="w-full max-w-[920px] flex flex-col md:flex-row items-center md:items-start justify-center gap-4 md:gap-6">
            <div className="flex flex-col items-center gap-3 w-[180px] sm:w-[260px] md:w-[320px] shrink-0">
              <div className="w-full aspect-[3/4] rounded-lg overflow-hidden border border-offbase shadow-lg">
                <DocumentPreview doc={activeDoc} />
              </div>
              <div className="text-center">
                <h2 className="text-[14px] font-semibold text-foreground truncate max-w-[320px]">
                  {activeDoc.name}
                </h2>
                <p className="text-[11px] text-muted">
                  {activeDoc.type.toUpperCase()} • {formatDocumentSize(activeDoc.size)}
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  href={openHref || '/app'}
                  prefetch={false}
                  className={buttonClass({ variant: 'primary', size: 'sm' })}
                >
                  Open
                </Link>
                <button
                  type="button"
                  onClick={() => onDeleteDoc(activeDoc)}
                  className={buttonClass({ variant: 'secondary', size: 'sm' })}
                >
                  Delete
                </button>
              </div>
            </div>
            <dl className="w-full max-w-[280px] sm:max-w-[360px] md:max-w-[340px] grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-offbase bg-base px-3 py-2 text-[11px] md:self-center">
              <dt className="text-muted">Type</dt>
              <dd className="text-foreground text-right uppercase tracking-wide">{activeDoc.type}</dd>
              <dt className="text-muted">Size</dt>
              <dd className="text-foreground text-right tabular-nums">{formatDocumentSize(activeDoc.size)}</dd>
              <dt className="text-muted">Last opened</dt>
              <dd className="text-foreground text-right">{formatDateTime(activeDoc.recentlyOpenedAt)}</dd>
              <dt className="text-muted">Last modified</dt>
              <dd className="text-foreground text-right">{formatDateTime(activeDoc.lastModified)}</dd>
              {activeDoc.folderId && (
                <>
                  <dt className="text-muted">Folder</dt>
                  <dd className="text-foreground text-right truncate" title={folderNameById?.[activeDoc.folderId] ?? activeDoc.folderId}>
                    {folderNameById?.[activeDoc.folderId] ?? activeDoc.folderId}
                  </dd>
                </>
              )}
              {activeDoc.type === 'pdf' && (
                <>
                  <dt className="text-muted">Parse status</dt>
                  <dd className="text-foreground text-right">{formatParseStatus(activeDoc.parseStatus)}</dd>
                </>
              )}
            </dl>
          </div>
        ) : (
          <p className="text-[12px] text-muted">No documents to show</p>
        )}
        </div>
      </div>

      <div className="shrink-0 border-t border-offbase bg-gradient-to-b from-base to-offbase/30">
        <div
          ref={railRef}
          className="flex gap-2.5 overflow-x-auto pl-4 pr-3 pt-2.5 pb-1.5 snap-x snap-proximity scroll-pl-4 sm:scroll-pl-5 scroll-pr-3 sm:scroll-pr-4"
        >
          {documents.map((doc, i) => (
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
