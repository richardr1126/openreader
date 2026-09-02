import { describe, expect, test } from 'vitest';
import type { DocumentListState } from '../../src/types/documents';
import {
  normalizeDocumentListState,
  serializeDocumentListState,
} from '../../src/components/doclist/document-list-preferences';

describe('document-list preferences', () => {
  test('normalizes missing fields and the former grid view', () => {
    expect(normalizeDocumentListState({
      sortBy: 'date',
      sortDirection: 'desc',
      showHint: false,
      viewMode: 'grid',
    })).toEqual({
      sortBy: 'date',
      sortDirection: 'desc',
      showHint: false,
      viewMode: 'icons',
      iconSize: 'md',
      sidebarWidth: 220,
      sidebarFilter: 'all',
      sidebarCollapsed: false,
    });
  });

  test('serializes only the current preference contract', () => {
    const stored = {
      sortBy: 'name',
      sortDirection: 'asc',
      showHint: true,
      viewMode: 'list',
      iconSize: 'lg',
      sidebarWidth: 280,
      sidebarFilter: 'folder:reading',
      sidebarCollapsed: true,
      folders: [{ id: 'obsolete' }],
      collapsedFolders: ['obsolete'],
    } as DocumentListState;

    expect(serializeDocumentListState(normalizeDocumentListState(stored))).toEqual({
      sortBy: 'name',
      sortDirection: 'asc',
      showHint: true,
      viewMode: 'list',
      iconSize: 'lg',
      sidebarWidth: 280,
      sidebarFilter: 'folder:reading',
      sidebarCollapsed: true,
    });
  });
});
