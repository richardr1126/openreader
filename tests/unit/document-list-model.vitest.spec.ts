import { describe, expect, test } from 'vitest';
import type { BaseDocument } from '../../src/types/documents';
import {
  deriveDocumentListModel,
  matchesDocumentSearch,
  sortDocuments,
  suggestFolderName,
} from '../../src/components/doclist/document-list-model';

const document = (
  id: string,
  name: string,
  type: 'pdf' | 'epub' | 'html',
  overrides: Partial<Omit<BaseDocument, 'type'>> = {},
): BaseDocument & { type: 'pdf' | 'epub' | 'html' } => ({
  id,
  name,
  type,
  size: 10,
  lastModified: 100,
  ...overrides,
});

const pdfs = [
  document('pdf-1', 'Zebra Guide.pdf', 'pdf', { size: 30, folderId: 'reading' }),
  document('pdf-2', 'Alpha Notes.pdf', 'pdf', { size: 20, recentlyOpenedAt: 200 }),
];
const epubs = [
  document('epub-1', 'Middle Book.epub', 'epub', { size: 40, recentlyOpenedAt: 400 }),
];
const html = [
  document('html-1', 'Alpha Article.txt', 'html', { size: 10, folderId: 'stale-folder' }),
];
const folders = [{ id: 'reading', name: 'Reading', position: 0 }];

function derive(overrides: Partial<Parameters<typeof deriveDocumentListModel>[0]> = {}) {
  return deriveDocumentListModel({
    pdfDocuments: pdfs,
    epubDocuments: epubs,
    htmlDocuments: html,
    serverFolders: folders,
    sidebarFilter: 'all',
    statusFilter: 'any',
    query: '',
    sortBy: 'name',
    sortDirection: 'asc',
    ...overrides,
  });
}

describe('document-list model', () => {
  test('derives live folders, counts, status data, and sorted documents', () => {
    const model = derive();

    expect(model.visibleDocuments.map((entry) => entry.name)).toEqual([
      'Alpha Article.txt',
      'Alpha Notes.pdf',
      'Middle Book.epub',
      'Zebra Guide.pdf',
    ]);
    expect(model.folders).toEqual([expect.objectContaining({
      id: 'reading',
      name: 'Reading',
      documents: [expect.objectContaining({ id: 'pdf-1', folderId: 'reading' })],
    })]);
    expect(model.allDocuments.find((entry) => entry.id === 'html-1')?.folderId).toBeUndefined();
    expect(model.counts).toEqual({ all: 4, pdf: 2, epub: 1, html: 1 });
    expect(model.visibleBytes).toBe(100);
  });

  test('filters folder contents and search text before applying the selected sort', () => {
    const folderModel = derive({ sidebarFilter: 'folder:reading' });
    expect(folderModel.visibleDocuments.map((entry) => entry.id)).toEqual(['pdf-1']);

    const searchModel = derive({
      query: 'alpha',
      sortBy: 'size',
      sortDirection: 'desc',
    });
    expect(searchModel.visibleDocuments.map((entry) => entry.id)).toEqual(['pdf-2', 'html-1']);
    expect(searchModel.visibleBytes).toBe(30);
  });

  test('keeps recents in last-opened order instead of applying toolbar sorting', () => {
    const model = derive({
      sidebarFilter: 'recents',
      sortBy: 'name',
      sortDirection: 'asc',
    });
    expect(model.visibleDocuments.map((entry) => entry.id)).toEqual(['epub-1', 'pdf-2']);
  });

  test('suggests a shared significant word or a deterministic dated fallback', () => {
    expect(suggestFolderName(
      document('1', 'Project Notes.pdf', 'pdf'),
      document('2', 'Project Brief.pdf', 'pdf'),
    )).toBe('Project');
    expect(suggestFolderName(
      document('1', 'One.pdf', 'pdf'),
      document('2', 'Two.epub', 'epub'),
      new Date('2026-07-18T12:00:00.000Z'),
    )).toBe('Folder 2026-07-18');
  });

  test('search matches name and author, ignoring case and diacritics, with every word required', () => {
    const doc = { name: 'Wuthering Heights.epub', author: 'Emily Brontë' };
    expect(matchesDocumentSearch(doc, 'bronte')).toBe(true);
    expect(matchesDocumentSearch(doc, 'BRONTË')).toBe(true);
    expect(matchesDocumentSearch(doc, '  wuthering   emily ')).toBe(true);
    expect(matchesDocumentSearch(doc, 'wuthering austen')).toBe(false);
    expect(matchesDocumentSearch({ name: 'Café Notes.pdf' }, 'cafe')).toBe(true);
    expect(matchesDocumentSearch({ name: 'Anything.pdf' }, '   ')).toBe(true);
  });

  test('search in the model also finds documents by author', () => {
    const model = derive({
      epubDocuments: [document('epub-2', 'wh.epub', 'epub', { author: 'Emily Brontë' }), ...epubs],
      query: 'Bronte',
    });
    expect(model.visibleDocuments.map((entry) => entry.id)).toEqual(['epub-2']);
  });

  test('filters by reading status before search and sort', () => {
    const progress = { fraction: 0.4, updatedAtMs: 1 };
    const withProgress = [
      document('pdf-1', 'Zebra Guide.pdf', 'pdf', { readingProgress: progress }),
      document('pdf-2', 'Alpha Notes.pdf', 'pdf', { readingProgress: { fraction: null, updatedAtMs: 2 } }),
      document('pdf-3', 'Beta Notes.pdf', 'pdf'),
    ];
    const reading = derive({ pdfDocuments: withProgress, epubDocuments: [], htmlDocuments: [], statusFilter: 'reading' });
    expect(reading.visibleDocuments.map((entry) => entry.id)).toEqual(['pdf-2', 'pdf-1']);
    const unread = derive({ pdfDocuments: withProgress, epubDocuments: [], htmlDocuments: [], statusFilter: 'unread' });
    expect(unread.visibleDocuments.map((entry) => entry.id)).toEqual(['pdf-3']);
    expect(unread.counts.all).toBe(3);
    const recentsUnread = derive({ statusFilter: 'unread', sidebarFilter: 'recents' });
    expect(recentsUnread.visibleDocuments.map((entry) => entry.id)).toEqual(['epub-1', 'pdf-2']);
    const recentsReading = derive({ statusFilter: 'reading', sidebarFilter: 'recents' });
    expect(recentsReading.visibleDocuments).toEqual([]);
  });

  test('sorts by author with author-less documents last in both directions, ties by name', () => {
    const docs = [
      document('1', 'b.epub', 'epub', { author: 'Austen' }),
      document('2', 'a.pdf', 'pdf'),
      document('3', 'a.epub', 'epub', { author: 'Austen' }),
      document('4', 'c.epub', 'epub', { author: 'Brontë' }),
    ];
    expect(sortDocuments(docs, 'author', 'asc').map((entry) => entry.id)).toEqual(['3', '1', '4', '2']);
    expect(sortDocuments(docs, 'author', 'desc').map((entry) => entry.id)).toEqual(['4', '3', '1', '2']);
  });

  test('sorts by recently opened with never-opened documents last in both directions', () => {
    const docs = [
      document('1', 'b.pdf', 'pdf', { recentlyOpenedAt: 100 }),
      document('2', 'a.pdf', 'pdf'),
      document('3', 'c.pdf', 'pdf', { recentlyOpenedAt: 300 }),
      document('4', 'd.pdf', 'pdf', { recentlyOpenedAt: 0 }),
    ];
    expect(sortDocuments(docs, 'opened', 'desc').map((entry) => entry.id)).toEqual(['3', '1', '2', '4']);
    expect(sortDocuments(docs, 'opened', 'asc').map((entry) => entry.id)).toEqual(['1', '3', '2', '4']);
  });

  test('sorts names naturally so numbered titles stay in reading order', () => {
    const docs = [
      document('1', 'Chapter 10.pdf', 'pdf'),
      document('2', 'Chapter 2.pdf', 'pdf'),
    ];
    expect(sortDocuments(docs, 'name', 'asc').map((entry) => entry.id)).toEqual(['2', '1']);
  });
});
