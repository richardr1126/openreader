export type DocumentType = 'pdf' | 'epub' | 'docx' | 'html';

export interface BaseDocument {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  recentlyOpenedAt?: number;
  contentVersion?: string;
  type: DocumentType;
  scope?: 'user';
  folderId?: string;
  /** Captured at import from document metadata or catalog; absent when unknown. */
  author?: string;
  /** BCP 47 tag captured at import (metadata or detected text); absent when unknown. */
  language?: string;
  /**
   * The user's saved reading position summary. Absent means the document has
   * never been opened far enough to save progress ("unread").
   */
  readingProgress?: DocumentReadingProgress;
}

export interface DocumentReadingProgress {
  /** 0..1 through the document, or null when the reader could not compute it. */
  fraction: number | null;
  updatedAtMs: number;
}

export interface PDFDocument extends BaseDocument {
  type: 'pdf';
  data: ArrayBuffer;
}

export interface HTMLDocument extends BaseDocument {
  type: 'html';
  data: string; // Store as string since it's text content
}

export interface EPUBDocument extends BaseDocument {
  type: 'epub';
  data: ArrayBuffer;
}

export type ReaderDocument = PDFDocument | EPUBDocument | HTMLDocument;

export interface DocumentListDocument extends BaseDocument {
  type: DocumentType;
}

export interface Folder {
  id: string;
  name: string;
  documents: DocumentListDocument[];
}

export type SortBy = 'name' | 'type' | 'date' | 'size';
export type SortDirection = 'asc' | 'desc';

export type ViewMode = 'icons' | 'list' | 'gallery';
export type IconSize = 'sm' | 'md' | 'lg' | 'xl';

// Filter applied from the sidebar.
// Examples: 'all', 'recents', 'pdf', 'epub', 'html', or `folder:<folderId>`.
export type SidebarFilter = string;

export interface DocumentListState {
  sortBy: SortBy;
  sortDirection: SortDirection;
  iosBetaBannerDismissed?: boolean;
  viewMode?: ViewMode | 'grid';
  iconSize?: IconSize;
  sidebarWidth?: number;
  sidebarFilter?: SidebarFilter;
  sidebarCollapsed?: boolean;
}

export interface LibraryDocument extends BaseDocument {
  // `id` is a stable server-provided reference, not necessarily the same as the local document id.
  id: string;
}
