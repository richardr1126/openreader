import type { DocumentListDocument, Folder } from '@/types/documents';

/** Everything a document row/tile/thumb needs to offer per-item and bulk actions. */
export interface DocumentActions {
  folders: Folder[];
  onDelete: (docs: DocumentListDocument[]) => void;
  /** `folderId: null` removes the documents from their folder. */
  onMove: (docs: DocumentListDocument[], folderId: string | null) => void;
  onNewFolder: (docs: DocumentListDocument[]) => void;
}
