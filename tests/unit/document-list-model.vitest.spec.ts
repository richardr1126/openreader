import { describe, expect, test } from 'vitest';
import type { BaseDocument } from '../../src/types/documents';
import {
  deriveDocumentListModel,
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
    expect(model.summary).toBe('2 PDFs • 1 EPUB • 1 Text Doc');
    expect(model.totalBytes).toBe(100);
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
});
