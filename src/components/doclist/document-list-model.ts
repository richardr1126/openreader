import type { ServerFolder } from '@/hooks/useFolders';
import type {
  BaseDocument,
  DocumentListDocument,
  Folder,
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
  summary: string;
  totalBytes: number;
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

export function sortDocuments(
  documents: DocumentListDocument[],
  sortBy: SortBy,
  direction: SortDirection,
): DocumentListDocument[] {
  const sorted = [...documents].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'type':
        return a.type.localeCompare(b.type);
      case 'size':
        return a.size - b.size;
      default:
        return a.lastModified - b.lastModified;
    }
  });
  return direction === 'asc' ? sorted : sorted.reverse();
}

function buildSummary(counts: DocumentListCounts): string {
  const parts: string[] = [];
  if (counts.pdf) parts.push(`${counts.pdf} PDF${counts.pdf === 1 ? '' : 's'}`);
  if (counts.epub) parts.push(`${counts.epub} EPUB${counts.epub === 1 ? '' : 's'}`);
  if (counts.html) parts.push(`${counts.html} Text${counts.html === 1 ? ' Doc' : ' Docs'}`);
  return parts.join(' • ');
}

export function deriveDocumentListModel({
  pdfDocuments,
  epubDocuments,
  htmlDocuments,
  serverFolders,
  sidebarFilter,
  query,
  sortBy,
  sortDirection,
}: {
  pdfDocuments: SupportedDocument[];
  epubDocuments: SupportedDocument[];
  htmlDocuments: SupportedDocument[];
  serverFolders: ServerFolder[];
  sidebarFilter: SidebarFilter;
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

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    visibleDocuments = visibleDocuments.filter((doc) =>
      doc.name.toLowerCase().includes(normalizedQuery),
    );
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
    summary: buildSummary(counts),
    totalBytes: allDocuments.reduce((total, document) => total + document.size, 0),
  };
}
