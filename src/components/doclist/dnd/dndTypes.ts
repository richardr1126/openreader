import type { DocumentListDocument } from '@/types/documents';

export const DND_DOCUMENT = 'openreader/document' as const;

export type DocumentIdentity = Pick<DocumentListDocument, 'id' | 'type'>;

export const documentIdentityKey = ({ id, type }: DocumentIdentity): string => `${type}|${id}`;

export interface DocumentDragItem {
  /** Doc identities being dragged together (may be a single doc). */
  items: DocumentIdentity[];
  /** Concrete doc records for the dragged identities — used for previews and folder hints. */
  docs: DocumentListDocument[];
  /** Folder id the drag originated from, if any (cross-folder vs unfoldered moves). */
  fromFolderId?: string;
}
