'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDrag, useDrop, type DragSourceMonitor } from 'react-dnd';
import { Button } from '@headlessui/react';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import type { DocumentListDocument, IconSize } from '@/types/documents';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { buttonClass } from '@/components/formPrimitives';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, type DocumentDragItem } from '../dnd/dndTypes';

interface DocumentTileProps {
  doc: DocumentListDocument;
  iconSize: IconSize;
  onDelete: (doc: DocumentListDocument) => void;
  /** Fired when two unfoldered docs are dropped together → caller should open a "create folder" dialog. */
  onMergeIntoFolder: (source: DocumentListDocument[], target: DocumentListDocument) => void;
}

const SIZE_LABEL: Record<IconSize, string> = { sm: 'S', md: 'M', lg: 'L', xl: 'XL' };
void SIZE_LABEL;

export function DocumentTile({
  doc,
  iconSize,
  onDelete,
  onMergeIntoFolder,
}: DocumentTileProps) {
  const [loading, setLoading] = useState(false);
  const { authEnabled } = useAuthConfig();
  const { data: session } = useAuthSession();
  const href = `/${doc.type}/${encodeURIComponent(doc.id)}`;
  const selection = useDocumentSelection();

  const isAnonymousAuthed = Boolean(authEnabled && session?.user?.isAnonymous);
  const showDeleteButton = !(isAnonymousAuthed && doc.scope === 'unclaimed');
  const isSelected = selection.isSelected(doc);
  const isInFolder = Boolean(doc.folderId);

  const [{ isDragging }, dragRef, previewRef] = useDrag<
    DocumentDragItem,
    void,
    { isDragging: boolean }
  >(() => {
    return {
      type: DND_DOCUMENT,
      item: () => {
        // If the dragged doc is selected and there are multiple selected, drag the group.
        const selected = selection.getSelectedDocs();
        const dragging = isSelected && selected.length > 1
          ? selected
          : [doc];
        // Reflect the actual drag in the selection so visuals match.
        if (!isSelected) selection.replace([doc]);
        return {
          ids: dragging.map((d) => d.id),
          docs: dragging,
          fromFolderId: doc.folderId,
        };
      },
      collect: (monitor: DragSourceMonitor) => ({ isDragging: monitor.isDragging() }),
    };
  }, [doc, isSelected]);

  const [{ isOver, canDrop }, dropRef] = useDrop<
    DocumentDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => {
      // Only allow drop-to-merge on unfoldered docs, and don't drop a doc on itself.
      if (isInFolder) return false;
      return !item.ids.includes(doc.id);
    },
    drop: (item) => onMergeIntoFolder(item.docs, doc),
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  }), [doc, isInFolder, onMergeIntoFolder]);

  const isDropTarget = isOver && canDrop;

  const setRefs = (node: HTMLDivElement | null) => {
    dragRef(node);
    dropRef(node);
    previewRef(node);
  };

  const handleClick: React.MouseEventHandler = (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      selection.select(doc, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      return;
    }
    selection.replace([doc]);
    setLoading(true);
  };

  // Cap any stuck loading flag if the user navigates back.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 2500);
    return () => clearTimeout(t);
  }, [loading]);

  const sizeClasses: Record<IconSize, string> = {
    sm: 'text-[10px]',
    md: 'text-[12px]',
    lg: 'text-[13px]',
    xl: 'text-[14px]',
  };

  return (
    <div
      ref={setRefs}
      data-doc-tile
      aria-selected={isSelected}
      className={
        'group relative flex flex-col rounded-md overflow-hidden border transition-all duration-200 ease-out hover:scale-[1.01] ' +
        (isSelected
          ? 'border-accent bg-offbase'
          : 'border-offbase bg-base hover:bg-offbase hover:border-accent') +
        (isDropTarget ? ' ring-1 ring-accent' : '') +
        (isDragging ? ' opacity-50' : '') +
        (loading ? ' prism-outline' : '')
      }
    >
      <Link
        href={href}
        draggable={false}
        className="block"
        aria-label={`Open ${doc.name}`}
        onClick={handleClick}
      >
        <DocumentPreview doc={doc} />
      </Link>
      <div className="flex items-center w-full px-1.5 py-1.5">
        <Link
          href={href}
          draggable={false}
          className="flex items-center gap-2 flex-1 min-w-0 rounded-md py-0.5 px-0.5"
          onClick={handleClick}
        >
          <span className="flex-shrink-0">
            {doc.type === 'pdf' ? (
              <PDFIcon className="w-4 h-4 text-red-500" />
            ) : doc.type === 'epub' ? (
              <EPUBIcon className="w-4 h-4 text-blue-500" />
            ) : (
              <FileIcon className="w-4 h-4 text-muted" />
            )}
          </span>
          <span className="flex flex-col min-w-0 w-full">
            <span
              className={
                'leading-tight font-medium truncate ' +
                sizeClasses[iconSize] +
                ' ' +
                (isSelected ? 'text-accent' : 'text-foreground group-hover:text-accent')
              }
            >
              {doc.name}
            </span>
            <span className="text-[9px] leading-tight text-muted truncate">
              {(doc.size / 1024 / 1024).toFixed(2)} MB
            </span>
          </span>
        </Link>
        {showDeleteButton && (
          <Button
            onClick={() => onDelete(doc)}
            className={buttonClass({
              variant: 'ghost',
              size: 'icon',
              className: 'ml-1 h-6 w-6 text-muted hover:bg-base',
            })}
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
        )}
      </div>
    </div>
  );
}
