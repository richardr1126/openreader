'use client';

import { useEffect, useState } from 'react';
import { useDragLayer, type XYCoord } from 'react-dnd';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import type { DocumentListDocument } from '@/types/documents';
import { DND_DOCUMENT, type DocumentDragItem } from './dndTypes';

function KindIcon({ doc }: { doc: DocumentListDocument }) {
  if (doc.type === 'pdf') return <PDFIcon className="w-4 h-4 shrink-0 text-danger" />;
  if (doc.type === 'epub') return <EPUBIcon className="w-4 h-4 shrink-0 text-accent" />;
  return <FileIcon className="w-4 h-4 shrink-0 text-soft" />;
}

/**
 * Drag preview for the touch backend, which renders no native drag image.
 * A single lightweight card (icon + name + count) shown for every view, so the
 * preview stays uniform across viewing modes and carries no thumbnail image.
 */
export function DocumentDragLayer() {
  const { isDragging, item, itemType, offset } = useDragLayer((monitor) => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem() as DocumentDragItem | null,
    itemType: monitor.getItemType(),
    offset: monitor.getClientOffset(),
  }));

  // A mouse drag on a non-anchor element (e.g. gallery thumbnails) otherwise
  // starts a text selection that smears across whatever it passes over. Lock
  // selection on the body for the duration of the drag and clear what's there.
  useEffect(() => {
    if (!isDragging) return;
    const style = document.body.style;
    const prev = style.userSelect;
    const prevWebkit = style.webkitUserSelect;
    style.userSelect = 'none';
    style.webkitUserSelect = 'none';
    window.getSelection?.()?.removeAllRanges();
    return () => {
      style.userSelect = prev;
      style.webkitUserSelect = prevWebkit;
    };
  }, [isDragging]);

  // The touch backend reports a null offset between some move frames; hold the
  // last known position so the card doesn't blink out and back mid-drag.
  const [heldOffset, setHeldOffset] = useState<XYCoord | null>(null);
  const pos = isDragging ? offset ?? heldOffset : null;
  if (pos !== heldOffset) setHeldOffset(pos);

  const docs = item?.docs ?? [];
  if (!isDragging || itemType !== DND_DOCUMENT || !pos || docs.length === 0) return null;

  const lead = docs[0];
  const extra = docs.length - 1;

  return (
    <div className="pointer-events-none fixed inset-0 z-100">
      <div
        className="absolute flex items-center gap-2 max-w-[220px] rounded-md border border-accent-line bg-surface px-2.5 py-1.5 shadow-elev-2"
        style={{ transform: `translate(${pos.x + 12}px, ${pos.y - 28}px)`, willChange: 'transform' }}
      >
        <KindIcon doc={lead} />
        <span className="truncate text-[12px] font-medium text-foreground">{lead.name}</span>
        {extra > 0 && (
          <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-background">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}
