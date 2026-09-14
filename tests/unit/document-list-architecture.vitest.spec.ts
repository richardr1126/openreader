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

  test('keeps one upload lifecycle owner instead of component callback aggregation', () => {
    const context = source('src/contexts/DocumentContext.tsx');
    const controller = source('src/components/doclist/useDocumentListController.ts');
    const uploader = source('src/components/documents/DocumentUploader.tsx');
    const libraryImport = source('src/components/documents/useLibraryImport.ts');
    const uploadController = source('src/hooks/useDocumentUploads.ts');

    expect(context).toContain('useDocumentUploads(documentsQueryKey)');
    expect(controller).not.toContain('activeUploadBatches');
    expect(uploader).not.toContain('UploadBatchState');
    expect(uploader).not.toContain('onUploadBatchChange');
    expect(libraryImport).not.toContain("uploadDocuments } from '@/lib/client/api/documents'");
    expect(libraryImport).not.toContain('cacheStoredDocumentFromBytes');
    expect(libraryImport).not.toContain('const files: File[]');
    expect(libraryImport).toContain('await uploadDocuments([file]');
    expect(uploadController).not.toContain('Promise.allSettled');
    expect(uploadController).toContain('remapProgressEvent(event, sourceIndexes)');
  });

  test('suppresses cancellation errors in upload entry points', () => {
    const dialog = source('src/components/documents/UploadMenuDialog.tsx');

    expect(dialog.split('if (isAbortError(err)) return;')).toHaveLength(3);
  });

  test('keys preview state by document version and keeps gallery scroll dependencies stable', () => {
    const preview = source('src/components/doclist/DocumentPreview.tsx');
    const gallery = source('src/components/doclist/views/GalleryView.tsx');

    expect(preview).toContain('previewState.key !== previewKey');
    expect(preview).toContain('`${doc.type}:${doc.id}:${Number(doc.lastModified)}`');
    expect(gallery).toContain('documentOrderSignature');
    expect(gallery).toContain('}, [documentOrderSignature]);');
  });
});
