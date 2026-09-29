'use client';

import { useEffect, useRef, useState } from 'react';
import type { DocumentListDocument, IconSize } from '@/types/documents';
import type { DocumentActions } from '../document-actions';
import { DocumentTile } from './DocumentTile';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { iconsGridStyle, maxColumnsForIconGrid } from './iconsGrid';

interface IconsViewProps {
  documents: DocumentListDocument[];
  iconSize: IconSize;
  actions: DocumentActions;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

export function IconsView({
  documents,
  iconSize,
  actions,
  onMergeIntoFolder,
}: IconsViewProps) {
  const { setVisibleOrder, clear } = useDocumentSelection();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [suppressSingleRowStretch, setSuppressSingleRowStretch] = useState(false);

  useEffect(() => {
    setVisibleOrder(documents);
  }, [documents, setVisibleOrder]);

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;

    const recompute = () => {
      const maxColumns = maxColumnsForIconGrid(iconSize, node.clientWidth);
      const isSingleRow = documents.length > 0 && documents.length <= maxColumns;
      setSuppressSingleRowStretch((prev) => (prev === isSingleRow ? prev : isSingleRow));
    };

    recompute();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => recompute());
    observer.observe(node);
    return () => observer.disconnect();
  }, [documents.length, iconSize]);

  const handleBackgroundClick: React.MouseEventHandler = (e) => {
    if ((e.target as HTMLElement).closest('[data-doc-tile]')) return;
    clear();
  };

  return (
    <div
      onClick={handleBackgroundClick}
      className="flex-1 min-h-0 overflow-y-auto p-3"
    >
      <div
        ref={gridRef}
        className="grid"
        style={iconsGridStyle(iconSize, documents.length, { suppressSingleRowStretch })}
      >
        {documents.map((doc) => (
          <DocumentTile
            key={`${doc.type}-${doc.id}`}
            doc={doc}
            iconSize={iconSize}
            actions={actions}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </div>
    </div>
  );
}
