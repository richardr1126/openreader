'use client';

import Link from 'next/link';
import { useDrag, useDrop, type DragSourceMonitor } from 'react-dnd';
import { Button } from '@headlessui/react';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import type { DocumentListDocument, IconSize } from '@/types/documents';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { DND_DOCUMENT, documentIdentityKey, type DocumentDragItem } from '../dnd/dndTypes';

interface DocumentTileProps {
  doc: DocumentListDocument;
  iconSize: IconSize;
  onDelete: (doc: DocumentListDocument) => void;
  /** Fired when two unfoldered docs are dropped together → caller should open a "create folder" dialog. */
  onMergeIntoFolder: (source: DocumentListDocument[], target: DocumentListDocument) => void;
}

const NAME_SIZE_CLASSES: Record<IconSize, string> = {
  sm: 'text-[10px]',
  md: 'text-[11px]',
  lg: 'text-[12px]',
  xl: 'text-[13px]',
};

const BOTTOM_PADDING_CLASSES: Record<IconSize, string> = {
  sm: 'px-[7px] py-[4px]',
  md: 'px-[8px] py-[5px]',
  lg: 'px-[9px] py-[5px]',
  xl: 'px-[10px] py-[6px]',
};

const LINK_PADDING_CLASS = 'px-[2px] py-[2px]';

const GAP_CLASSES: Record<IconSize, string> = {
  sm: 'gap-1',
  md: 'gap-1.5',
  lg: 'gap-2',
  xl: 'gap-2',
};

const FILE_ICON_CLASSES: Record<IconSize, string> = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
  lg: 'w-3.5 h-3.5',
  xl: 'w-4 h-4',
};

const TRASH_BTN_CLASSES: Record<IconSize, string> = {
  sm: 'ml-0.5 h-[18px] w-[18px] rounded-sm',
  md: 'ml-0.5 h-[21px] w-[21px] rounded-sm',
  lg: 'ml-1 h-[23px] w-[23px] rounded',
  xl: 'ml-1.5 h-[25px] w-[25px] rounded',
};

const TRASH_ICON_CLASSES: Record<IconSize, string> = {
  sm: 'w-[10px] h-[10px]',
  md: 'w-[11px] h-[11px]',
  lg: 'w-[12px] h-[12px]',
  xl: 'w-[13px] h-[13px]',
};

export function DocumentTile({
  doc,
  iconSize,
  onDelete,
  onMergeIntoFolder,
}: DocumentTileProps) {
  const href = `/${doc.type}/${encodeURIComponent(doc.id)}`;
  const selection = useDocumentSelection();

  const showDeleteButton = true;
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
          items: dragging.map(({ id, type }) => ({ id, type })),
          docs: dragging,
          fromFolderId: doc.folderId,
        };
      },
      collect: (monitor: DragSourceMonitor) => ({ isDragging: monitor.isDragging() }),
    };
  }, [doc, isSelected, selection]);

  const [{ isOver, canDrop }, dropRef] = useDrop<
    DocumentDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: DND_DOCUMENT,
    canDrop: (item) => {
      // Only allow drop-to-merge on unfoldered docs, and don't drop a doc on itself.
      if (isInFolder) return false;
      return !item.items.some((it) => documentIdentityKey(it) === documentIdentityKey(doc));
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
    }
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
        (isDragging ? ' opacity-50' : '')
      }
    >
      <Link
        href={href}
        prefetch={false}
        draggable={false}
        className="block"
        aria-label={`Open ${doc.name}`}
        onClick={handleClick}
      >
        <DocumentPreview doc={doc} />
      </Link>
      <div className={`flex items-center w-full ${BOTTOM_PADDING_CLASSES[iconSize]}`}>
        <Link
          href={href}
          prefetch={false}
          draggable={false}
          className={`flex items-center flex-1 min-w-0 rounded-md ${LINK_PADDING_CLASS} ${GAP_CLASSES[iconSize]}`}
          onClick={handleClick}
        >
          <span className="flex-shrink-0 flex items-center">
            {doc.type === 'pdf' ? (
              <PDFIcon className={`${FILE_ICON_CLASSES[iconSize]} text-red-500`} />
            ) : doc.type === 'epub' ? (
              <EPUBIcon className={`${FILE_ICON_CLASSES[iconSize]} text-blue-500`} />
            ) : (
              <FileIcon className={`${FILE_ICON_CLASSES[iconSize]} text-muted`} />
            )}
          </span>
          <span
            className={
              'leading-none font-medium truncate flex-1 min-w-0 ' +
              NAME_SIZE_CLASSES[iconSize] +
              ' ' +
              (isSelected ? 'text-accent' : 'text-foreground group-hover:text-accent')
            }
          >
            {doc.name}
          </span>
        </Link>
        {showDeleteButton && (
          <Button
            onClick={() => onDelete(doc)}
            className={`inline-flex items-center justify-center text-muted hover:text-accent hover:bg-base focus:outline-none transition-colors duration-200 ${TRASH_BTN_CLASSES[iconSize]}`}
            aria-label={`Delete ${doc.name}`}
          >
            <svg className={TRASH_ICON_CLASSES[iconSize]} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
