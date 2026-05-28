'use client';

import { useEffect } from 'react';
import type { DocumentListDocument, IconSize } from '@/types/documents';
import { DocumentTile } from './DocumentTile';
import { useDocumentSelection } from '../dnd/DocumentSelectionContext';
import { iconsGridStyle } from './iconsGrid';

interface IconsViewProps {
  documents: DocumentListDocument[];
  iconSize: IconSize;
  onDeleteDoc: (doc: DocumentListDocument) => void;
  onMergeIntoFolder: (sources: DocumentListDocument[], target: DocumentListDocument) => void;
}

export function IconsView({
  documents,
  iconSize,
  onDeleteDoc,
  onMergeIntoFolder,
}: IconsViewProps) {
  const { setVisibleOrder, clear } = useDocumentSelection();

  useEffect(() => {
    setVisibleOrder(documents);
  }, [documents, setVisibleOrder]);

  const handleBackgroundClick: React.MouseEventHandler = (e) => {
    if ((e.target as HTMLElement).closest('[data-doc-tile]')) return;
    clear();
  };

  return (
    <div
      onClick={handleBackgroundClick}
      className="flex-1 min-h-0 overflow-y-auto p-3"
    >
      <div className="grid" style={iconsGridStyle(iconSize, documents.length)}>
        {documents.map((doc) => (
          <DocumentTile
            key={`${doc.type}-${doc.id}`}
            doc={doc}
            iconSize={iconSize}
            onDelete={onDeleteDoc}
            onMergeIntoFolder={onMergeIntoFolder}
          />
        ))}
      </div>
    </div>
  );
}
