import Link from 'next/link';
import { DragEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@headlessui/react';
import { PDFIcon, EPUBIcon, FileIcon } from '@/components/icons/Icons';
import { DocumentListDocument } from '@/types/documents';
import { DocumentPreview } from '@/components/doclist/DocumentPreview';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';

interface DocumentListItemProps {
  doc: DocumentListDocument;
  onDelete: (doc: DocumentListDocument) => void;
  dragEnabled?: boolean;
  onDragStart?: (doc: DocumentListDocument) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent, doc: DocumentListDocument) => void;
  onDragLeave?: () => void;
  onDrop?: (e: DragEvent, doc: DocumentListDocument) => void;
  isDropTarget?: boolean;
  viewMode: 'list' | 'grid';
}

export function DocumentListItem({
  doc,
  onDelete,
  dragEnabled = true,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  isDropTarget = false,
  viewMode,
}: DocumentListItemProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { authEnabled } = useAuthConfig();
  const { data: session } = useAuthSession();

  // Only allow drag and drop interactions for documents not in folders
  const isDraggable = dragEnabled && !doc.folderId;
  const allowDropTarget = !doc.folderId;
  const isAnonymousAuthed = Boolean(authEnabled && session?.user?.isAnonymous);
  const showDeleteButton = !(isAnonymousAuthed && doc.scope === 'unclaimed');

  const handleDocumentClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setLoading(true);
    router.push(`/${doc.type}/${encodeURIComponent(doc.id)}`);
  };

  return (
    <div
      draggable={isDraggable}
      onDragStart={() => onDragStart?.(doc)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => allowDropTarget && onDragOver?.(e, doc)}
      onDragLeave={() => allowDropTarget && onDragLeave?.()}
      onDrop={(e) => allowDropTarget && onDrop?.(e, doc)}
      aria-busy={loading}
      className={
        viewMode === 'grid'
          ? `
            flex w-full min-w-0 flex-col
            group border border-offbase rounded-md overflow-hidden
            transition-colors duration-150 relative bg-base hover:bg-offbase
            ${allowDropTarget && isDropTarget ? 'ring-2 ring-accent' : ''}
            ${loading ? 'prism-outline' : ''}
          `
          : `
            w-full group
            ${allowDropTarget && isDropTarget ? 'ring-2 ring-accent' : ''}
            ${loading ? 'prism-outline' : 'bg-base hover:bg-offbase'}
            border border-offbase rounded-md p-1
            transition-colors duration-150 relative
          `
      }
    >
      {viewMode === 'grid' ? (
        <>
          <Link
            href={`/${doc.type}/${encodeURIComponent(doc.id)}`}
            draggable={false}
            className="block"
            aria-label="Open document preview"
            onClick={handleDocumentClick}
          >
            <DocumentPreview doc={doc} />
          </Link>
          <div className="flex items-center w-full px-1.5 py-1.5">
            <Link
              href={`/${doc.type}/${encodeURIComponent(doc.id)}`}
              draggable={false}
              className="document-link flex items-center gap-2 flex-1 min-w-0 rounded-md py-0.5 px-0.5"
              onClick={handleDocumentClick}
            >
              <div className="flex-shrink-0">
                {doc.type === 'pdf' ? (
                  <PDFIcon className="w-5 h-5 sm:w-6 sm:h-6 text-red-500" />
                ) : doc.type === 'epub' ? (
                  <EPUBIcon className="w-5 h-5 sm:w-6 sm:h-6 text-blue-500" />
                ) : (
                  <FileIcon className="w-6 h-6 sm:w-6 sm:h-6 text-muted" />
                )}
              </div>
              <div className="flex flex-col min-w-0 transform transition-transform duration-150 ease-in-out hover:scale-[1.009] w-full truncate">
                <p className="text-[12px] sm:text-[13px] leading-tight text-foreground font-medium truncate group-hover:text-accent">
                  {doc.name}
                </p>
                <p className="text-[9px] sm:text-[10px] leading-tight text-muted truncate">
                  {(doc.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            </Link>
            {showDeleteButton && (
              <Button
                onClick={() => onDelete(doc)}
                className="ml-1 p-1.5 text-muted hover:text-accent rounded-md hover:bg-offbase transition-colors"
                aria-label="Delete document"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="flex items-center w-full">
          <Link
            href={`/${doc.type}/${encodeURIComponent(doc.id)}`}
            draggable={false}
            className="document-link flex items-center align-center gap-2 flex-1 min-w-0 rounded-md py-0.5 px-0.5"
            onClick={handleDocumentClick}
          >
            <div className="flex-shrink-0">
              {doc.type === 'pdf' ? (
                <PDFIcon className="w-5 h-5 sm:w-6 sm:h-6 text-red-500" />
              ) : doc.type === 'epub' ? (
                <EPUBIcon className="w-5 h-5 sm:w-6 sm:h-6 text-blue-500" />
              ) : (
                <FileIcon className="w-6 h-6 sm:w-6 sm:h-6 text-muted" />
              )}
            </div>
            <div className="flex flex-col min-w-0 transform transition-transform duration-150 ease-in-out hover:scale-[1.009] w-full truncate">
              <p className="text-[12px] sm:text-[13px] leading-tight text-foreground font-medium truncate group-hover:text-accent">
                {doc.name}
              </p>
              <p className="text-[9px] sm:text-[10px] leading-tight text-muted truncate">
                {(doc.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          </Link>
          {showDeleteButton && (
            <Button
              onClick={() => onDelete(doc)}
              className="ml-1 p-1.5 text-muted hover:text-accent rounded-md hover:bg-offbase transition-colors"
              aria-label="Delete document"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
