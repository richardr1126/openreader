import { existsSync, readFileSync } from 'node:fs';
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

  test('reconciles the first committed EPUB location from rendition lifecycle events', () => {
    const controller = source('src/hooks/epub/useEPUBLocationController.ts');
    expect(controller).not.toMatch(/isEpubSetOnceRef\.current = true;\s+safeRenditionNavigate\('display'/);
    expect(controller).not.toContain('scheduleProgress');
    expect(controller).not.toContain('extractPageText');

    const epubDocument = source('src/app/(app)/epub/[id]/useEpubDocument.ts');
    expect(epubDocument).toContain("rendition.on('rendered', requestFromRendered)");
    expect(epubDocument).toContain("rendition.on('relocated', requestFromRelocated)");
    expect(epubDocument).toContain('schemaVersion: 1');
    expect(epubDocument).toContain('startupDisplayStartedRef.current = true');
    expect(source('src/components/views/EPUBViewer.tsx')).toContain('Deliberately do not call display here');
    expect(epubDocument).not.toContain('setTimeout');
    expect(epubDocument).not.toContain('Promise.resolve().then(requestFromRelocated)');
    expect(epubDocument).toContain('reconcileEpubRenderedAnchor({');
    expect(epubDocument).not.toContain('setTTSText');
  });

  test('hard-cuts EPUB progress and startup to stable plan locators', () => {
    const readerProgress = source('src/lib/client/reader-progress.ts');
    expect(readerProgress).not.toContain('export {');
    expect(readerProgress).not.toContain('const legacy = parsePositionToken(location)');

    const progressTypes = source('src/types/user-state.ts');
    expect(progressTypes).toContain("{ readerType: 'epub'; locator: EpubProgressLocator }");
    expect(progressTypes).not.toContain("{ readerType: 'epub'; location: string }");

    const progressRoute = source('src/app/api/user/state/progress/route.ts');
    expect(progressRoute).toContain('normalizeEpubProgressLocator(body?.locator)');
    expect(progressRoute).toContain('progress: null, invalidated: true');

    const page = source('src/app/(app)/epub/[id]/page.tsx');
    expect(page).not.toContain('viewerRevision');
    expect(page).not.toContain('setViewerRevision');

    const viewer = source('src/components/views/EPUBViewer.tsx');
    expect(viewer).not.toContain('ReactReader');
    expect(viewer).not.toContain('rendition.display(');

    const controller = source('src/app/(app)/epub/[id]/useEpubDocument.ts');
    expect(controller).toContain('resolveEpubPlanLocator(saved ?');
    expect(controller).toContain('await Promise.resolve(displayTarget ? rendition.display(displayTarget) : rendition.display())');
    expect(controller).not.toContain('initialLocation?: string');
    expect(controller).not.toContain('initialLocator?:');

    const locationController = source('src/hooks/epub/useEPUBLocationController.ts');
    expect(locationController).not.toContain('export {');
  });

  test('keeps EPUB and HTML on committed surfaces while PDF is reset to its working baseline', () => {
    const playbackModel = source('src/hooks/audio/useTtsPlaybackModel.ts');
    expect(playbackModel).toContain('model.selectedOrdinal === null');

    const planController = source('src/hooks/audio/useTtsPlanController.ts');
    expect(planController).toContain('requestKeyRef.current = requestKey');
    expect(planController).toContain('requestKeyRef.current !== operationKey');

    const epubViewer = source('src/components/views/EPUBViewer.tsx');
    const epubHighlighting = source('src/hooks/epub/useEPUBHighlighting.ts');
    const epubCoordinates = source('src/lib/client/epub/spine-coordinates.ts');
    const documentNavigation = source('src/hooks/audio/useTtsDocumentNavigation.ts');
    expect(epubViewer).toContain('useLayoutEffect');
    expect(epubViewer).toContain('renderedTextRevision');
    expect(epubHighlighting).not.toContain('annotations.add');
    expect(epubHighlighting).not.toContain('annotations.remove');
    expect(epubHighlighting).not.toContain('currentHighlightCfi');
    expect(epubHighlighting).not.toContain('currentWordHighlightCfi');
    expect(epubCoordinates).toContain('range.comparePoint');
    expect(epubCoordinates).not.toContain('findSegmentOffset');
    expect(epubCoordinates).not.toContain('chunkText');
    expect(documentNavigation).toContain("return { status: 'non-text' }");

    const pdfViewer = source('src/components/views/PDFViewer.tsx');
    const pdfPage = source('src/app/(app)/pdf/[id]/page.tsx');
    const pdfHighlighting = source('src/lib/client/pdf.ts');
    const htmlViewer = source('src/components/views/HTMLViewer.tsx');
    // PDF deliberately remains at the last working pre-c00 baseline until the
    // identity-based state-machine hard cut. Do not reintroduce the rejected
    // geometry-as-readiness/error-feedback implementation while it is reset.
    expect(pdfViewer).not.toContain('failedSurfaceCommitKeyRef');
    expect(pdfViewer).not.toContain('reportSurfaceCommitError');
    expect(pdfPage).not.toContain('deriveReaderLoadState');
    expect(pdfPage).not.toContain('viewerError');
    expect(pdfHighlighting).toContain('runHighlightTokenMatch');
    expect(pdfHighlighting).toContain('useBlockGeometryOnly');
    expect(existsSync(resolve(root, 'src/lib/client/pdf-highlight-worker.ts'))).toBe(true);
    expect(htmlViewer).not.toContain('scheduleSentence');
    expect(htmlViewer).not.toContain('scheduleWord');
  });
});
