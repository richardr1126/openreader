import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

describe('document-list ownership', () => {
  test('keeps the visual shell composed over an explicit controller', () => {
    const component = source('src/components/doclist/DocumentList.tsx');

    expect(component).toContain("from './useDocumentListController'");
    expect(component).not.toContain('useDocuments(');
    expect(component).not.toContain('useFolders(');
    expect(component).not.toContain('useUserPreferences(');
    expect(component.split('\n').length).toBeLessThan(350);
  });

  test('keeps mutations in existing query hooks and derivation in pure modules', () => {
    const controller = source('src/components/doclist/useDocumentListController.ts');
    const model = source('src/components/doclist/document-list-model.ts');
    const preferences = source('src/components/doclist/document-list-preferences.ts');

    expect(controller).toContain('useDocuments()');
    expect(controller).toContain('useFolders()');
    expect(controller).toContain('useUserPreferences(');
    expect(controller).not.toContain("fetch('");
    expect(model).not.toContain('useMemo');
    expect(preferences).not.toContain('useState');
  });
});
