'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import type { DocumentListDocument } from '@/types/documents';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { formatDocumentSize } from '@/components/doclist/formatSize';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

interface ColumnsViewProps {
  documents: DocumentListDocument[];
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

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
        'group flex items-center gap-2 px-2 py-1 rounded-md text-[12px] border transform transition-all duration-200 ease-out cursor-pointer text-left hover:scale-[1.01] ' +
        (active || isSelected
          ? 'border-accent bg-offbase text-accent'
          : 'border-transparent text-foreground hover:border-accent hover:bg-offbase hover:text-accent') +
        (isOver && canDrop ? ' ring-1 ring-accent' : '') +
        (isDragging ? ' opacity-50' : '')
      }
    >
      <span className={'w-4 h-4 shrink-0 flex items-center justify-center transition-colors duration-200 ' + ((active || isSelected) ? 'text-accent' : 'text-muted group-hover:text-accent')}>
        <KindIcon doc={doc} />
      </span>
      <span className="truncate flex-1">{doc.name}</span>
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
  documents,
  onDeleteDoc,
  onMergeIntoFolder,
}: ColumnsViewProps) {
  const { setVisibleOrder } = useDocumentSelection();
  const [selectedDoc, setSelectedDoc] = useState<DocumentListDocument | null>(null);
  const openHref = selectedDoc
    ? `/${selectedDoc.type}/${encodeURIComponent(selectedDoc.id)}`
    : null;

  useEffect(() => {
    setVisibleOrder(documents);
  }, [documents, setVisibleOrder]);

  useEffect(() => {
    if (documents.length === 0) {
      if (selectedDoc !== null) setSelectedDoc(null);
      return;
    }

    if (!selectedDoc) {
      setSelectedDoc(documents[0]);
      return;
    }

    const selectedStillExists = documents.some(
      (d) => d.id === selectedDoc.id && d.type === selectedDoc.type,
    );
    if (!selectedStillExists) {
      setSelectedDoc(documents[0]);
    }
  }, [documents, selectedDoc]);

  return (
    <div className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden">
      <Column title="Documents">
        {documents.map((doc) => (
          <ColumnDocRow
            key={`${doc.type}-${doc.id}`}
            doc={doc}
            active={selectedDoc?.id === doc.id && selectedDoc?.type === doc.type}
            onClick={() => setSelectedDoc(doc)}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </Column>

      {selectedDoc && (
        <div className="flex-1 min-w-[280px] h-full bg-background overflow-y-auto p-4">
          <div className="max-w-[360px] mx-auto">
            <div className="rounded-lg overflow-hidden border border-offbase">
              <DocumentPreview doc={selectedDoc} />
            </div>
            <h3 className="mt-3 text-[13px] font-semibold text-foreground truncate">
              {selectedDoc.name}
            </h3>
            <p className="text-[11px] text-muted">
              {selectedDoc.type.toUpperCase()} • {formatDocumentSize(selectedDoc.size)}
            </p>
            <div className="mt-3 flex gap-2">
              <Link
                href={openHref || '/app'}
                prefetch={false}
                className="flex-1 inline-flex items-center justify-center h-8 rounded-md bg-accent text-background text-[12px] font-medium hover:bg-secondary-accent hover:scale-[1.01] transition-all duration-200 ease-out"
              >
                Open
              </Link>
              <button
                type="button"
                onClick={() => onDeleteDoc(selectedDoc)}
                className="h-8 px-3 rounded-md border border-offbase bg-base text-[12px] text-muted hover:text-accent hover:border-accent hover:bg-offbase hover:scale-[1.01] transition-all duration-200 ease-out"
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
