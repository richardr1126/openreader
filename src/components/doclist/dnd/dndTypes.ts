import type { DocumentListDocument } from '@/types/documents';

export const DND_DOCUMENT = 'openreader/document' as const;

export interface DocumentDragItem {
  /** Doc ids being dragged together (may be a single id). */
  ids: string[];
  /** Concrete doc records for the dragged ids — used for previews and folder hints. */
  docs: DocumentListDocument[];
  /** Folder id the drag originated from, if any (cross-folder vs unfoldered moves). */
  fromFolderId?: string;
}

export type DropTarget =
  | { kind: 'document'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'sidebar-folder'; id: string }
  | { kind: 'pane'; id: 'unfoldered' };
