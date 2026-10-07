import type { ServerFolder } from '@/hooks/useFolders';
import type {
  BaseDocument,
  DocumentListDocument,
  Folder,
  ReadingStatusFilter,
  SidebarFilter,
  SortBy,
  SortDirection,
} from '@/types/documents';
import { documentIdentityKey } from './dnd/dndTypes';

type SupportedDocument = BaseDocument & { type: 'pdf' | 'epub' | 'html' };

export type DocumentListCounts = {
  all: number;
  pdf: number;
  epub: number;
  html: number;
};

export type DocumentListModel = {
  allDocuments: DocumentListDocument[];
  visibleDocuments: DocumentListDocument[];
  folders: Folder[];
  folderNameById: Record<string, string>;
  counts: DocumentListCounts;
  visibleBytes: number;
};

export function suggestFolderName(
  doc1: DocumentListDocument,
  doc2: DocumentListDocument,
  date = new Date(),
): string {
  const words1 = doc1.name.toLowerCase().split(/[\s\-_.]+/);
  const words2 = doc2.name.toLowerCase().split(/[\s\-_.]+/);
  const common = words1.filter((word) => words2.includes(word));
  const significant = common.find((word) => word.length >= 3);
  if (significant) {
    if (significant === 'pdf') return 'PDFs';
    if (significant === 'epub') return 'EPUBs';
    if (significant === 'txt' || significant === 'md') return 'Documents';
    return significant.charAt(0).toUpperCase() + significant.slice(1);
  }
  return `Folder ${date.toISOString().slice(0, 10)}`;
}

/** Lowercases and strips combining marks so "Brontë" and "bronte" compare equal. */
export function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Whether a document answers a library search: every whitespace-separated word
 * must appear in its name or author, ignoring case and diacritics, so more
 * words narrow the result instead of widening it.
 */
export function matchesDocumentSearch(
  document: Pick<DocumentListDocument, 'name' | 'author'>,
  query: string,
): boolean {
  const words = foldSearchText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = foldSearchText(`${document.name} ${document.author ?? ''}`);
  return words.every((word) => haystack.includes(word));
}

/** "In progress" means the user has a saved reading position; absent means unread. */
export function matchesReadingStatus(
  document: Pick<DocumentListDocument, 'readingProgress'>,
  status: ReadingStatusFilter,
): boolean {
  if (status === 'reading') return document.readingProgress !== undefined;
  if (status === 'unread') return document.readingProgress === undefined;
  return true;
}

const compareText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sorts by the chosen key in the chosen direction. Documents missing the key
 * (no author, never opened) stay last in either direction, and ties fall back
 * to name A→Z so the order holds still between renders.
 */
export function sortDocuments(
  documents: DocumentListDocument[],
  sortBy: SortBy,
  direction: SortDirection,
): DocumentListDocument[] {
  const sign = direction === 'asc' ? 1 : -1;
  const primary = (a: DocumentListDocument, b: DocumentListDocument): number => {
    switch (sortBy) {
      case 'name':
        return sign * compareText(a.name, b.name);
      case 'type':
        return sign * a.type.localeCompare(b.type);
      case 'size':
        return sign * (a.size - b.size);
      case 'author': {
        const left = a.author?.trim() ?? '';
        const right = b.author?.trim() ?? '';
        if (!left || !right) return Number(!left) - Number(!right);
        return sign * compareText(left, right);
      }
      case 'opened': {
        const left = a.recentlyOpenedAt ?? 0;
        const right = b.recentlyOpenedAt ?? 0;
        if (left <= 0 || right <= 0) return Number(left <= 0) - Number(right <= 0);
        return sign * (left - right);
      }
      default:
        return sign * (a.lastModified - b.lastModified);
    }
  };
  return [...documents].sort((a, b) => primary(a, b) || compareText(a.name, b.name));
}

export function deriveDocumentListModel({
  pdfDocuments,
  epubDocuments,
  htmlDocuments,
  serverFolders,
  sidebarFilter,
  statusFilter,
  query,
  sortBy,
  sortDirection,
}: {
  pdfDocuments: SupportedDocument[];
  epubDocuments: SupportedDocument[];
  htmlDocuments: SupportedDocument[];
  serverFolders: ServerFolder[];
  sidebarFilter: SidebarFilter;
  statusFilter: ReadingStatusFilter;
  query: string;
  sortBy: SortBy;
  sortDirection: SortDirection;
}): DocumentListModel {
  const rawDocuments: DocumentListDocument[] = [
    ...pdfDocuments,
    ...epubDocuments,
    ...htmlDocuments,
  ];
  const documentsById = new Map<string, DocumentListDocument>(
    rawDocuments.map((document) => [documentIdentityKey(document), {
      ...document,
      recentlyOpenedAt: document.recentlyOpenedAt ?? 0,
    }]),
  );
  const folders = serverFolders.map<Folder>((folder) => ({
    id: folder.id,
    name: folder.name,
    documents: rawDocuments
      .filter((document) => document.folderId === folder.id)
      .map((document) => ({
        ...document,
        recentlyOpenedAt: document.recentlyOpenedAt ?? 0,
        folderId: folder.id,
      })),
  }));
  const liveFolderIds = new Set(folders.map((folder) => folder.id));
  const allDocuments: DocumentListDocument[] = [...documentsById.values()].map((document) => ({
    ...document,
    folderId: document.folderId && liveFolderIds.has(document.folderId)
      ? document.folderId
      : undefined,
  }));
  const allDocumentsById = new Map(
    allDocuments.map((document) => [documentIdentityKey(document), document]),
  );
  const folderNameById = Object.fromEntries(
    folders.map((folder) => [folder.id, folder.name]),
  );

  let visibleDocuments: DocumentListDocument[] = allDocuments;
  if (sidebarFilter === 'pdf') visibleDocuments = visibleDocuments.filter((doc) => doc.type === 'pdf');
  else if (sidebarFilter === 'epub') visibleDocuments = visibleDocuments.filter((doc) => doc.type === 'epub');
  else if (sidebarFilter === 'html') visibleDocuments = visibleDocuments.filter((doc) => doc.type === 'html');
  else if (sidebarFilter === 'recents') {
    visibleDocuments = [...visibleDocuments]
      .filter((doc) => (doc.recentlyOpenedAt ?? 0) > 0)
      .sort((a, b) => (b.recentlyOpenedAt ?? 0) - (a.recentlyOpenedAt ?? 0))
      .slice(0, 20);
  } else if (sidebarFilter.startsWith('folder:')) {
    const folderId = sidebarFilter.slice('folder:'.length);
    const folder = folders.find((candidate) => candidate.id === folderId);
    visibleDocuments = folder
      ? folder.documents
          .map((document) => allDocumentsById.get(documentIdentityKey(document)))
          .filter((document): document is DocumentListDocument => Boolean(document))
          .map((document) => ({ ...document, folderId }))
      : [];
  }

  if (statusFilter !== 'any') {
    visibleDocuments = visibleDocuments.filter((doc) => matchesReadingStatus(doc, statusFilter));
  }
  if (query.trim()) {
    visibleDocuments = visibleDocuments.filter((doc) => matchesDocumentSearch(doc, query));
  }
  if (sidebarFilter !== 'recents') {
    visibleDocuments = sortDocuments(visibleDocuments, sortBy, sortDirection);
  }

  const counts = {
    all: allDocuments.length,
    pdf: pdfDocuments.length,
    epub: epubDocuments.length,
    html: htmlDocuments.length,
  };
  return {
    allDocuments,
    visibleDocuments,
    folders,
    folderNameById,
    counts,
    visibleBytes: visibleDocuments.reduce((total, document) => total + document.size, 0),
  };
}
