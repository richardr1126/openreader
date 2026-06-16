import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('reader server-state ownership', () => {
  test('queries progress only through the route bootstrap', () => {
    expect(source('src/hooks/useReaderBootstrap.ts')).toContain('useDocumentProgress(documentId)');
    expect(source('src/contexts/TTSContext.tsx')).not.toContain('useDocumentProgress(');
    expect(source('src/hooks/epub/useEPUBLocationController.ts')).not.toContain('useDocumentProgress(');
  });

  test('queries document settings only through the route bootstrap', () => {
    expect(source('src/hooks/useReaderBootstrap.ts')).toContain('useDocumentSettings(documentId)');
    expect(source('src/app/(app)/pdf/[id]/usePdfDocument.ts')).not.toContain('useDocumentSettings');
    expect(source('src/app/(app)/epub/[id]/page.tsx')).not.toContain('useDocumentSettings');
    expect(source('src/app/(app)/html/[id]/page.tsx')).not.toContain('useDocumentSettings');
  });

  test('disables and flushes progress before reader cleanup can reset location state', () => {
    const bootstrap = source('src/hooks/useReaderBootstrap.ts');
    expect(bootstrap).toContain('progressPersistenceEnabledRef.current = false');
    expect(bootstrap).toContain('flushDocumentProgress()');

    for (const path of [
      'src/app/(app)/pdf/[id]/page.tsx',
      'src/app/(app)/epub/[id]/page.tsx',
      'src/app/(app)/html/[id]/page.tsx',
    ]) {
      const page = source(path);
      expect(page).toMatch(/disableProgressPersistence\(\);\s+clearCurrDoc\(\);/);
    }
  });

  test('does not restart reader sessions when live playback callbacks change', () => {
    for (const path of [
      'src/app/(app)/pdf/[id]/page.tsx',
      'src/app/(app)/epub/[id]/page.tsx',
      'src/app/(app)/html/[id]/page.tsx',
    ]) {
      const page = source(path);
      expect(page).toContain('const stopRef = useLatestRef(stop)');
      expect(page).toContain('const disableProgressPersistenceRef = useLatestRef(disableProgressPersistence)');
      expect(page).toMatch(/disableProgressPersistenceRef\.current\(\);\s+stopRef\.current\(\);/);
      expect(page).not.toMatch(/\}, \[disableProgressPersistence, (?:id|routeDocumentId), stop\]\);/);
    }
  });

  test('extracts text from the first rendered EPUB location instead of waiting for a second callback', () => {
    const controller = source('src/hooks/epub/useEPUBLocationController.ts');
    expect(controller).toContain('const isInitialRenderedLocation = !isEpubSetOnceRef.current');
    expect(controller).not.toMatch(/isEpubSetOnceRef\.current = true;\s+safeRenditionNavigate\('display'/);
    expect(controller).toContain('!isInitialRenderedLocation && shouldPersistEpubLocation');

    const epubDocument = source('src/app/(app)/epub/[id]/useEpubDocument.ts');
    expect(epubDocument).toContain("rendition.on('relocated', initializeFromRelocated)");
    expect(epubDocument).toContain('void extractPageText(book, rendition, shouldPauseRef.current)');
  });
});
