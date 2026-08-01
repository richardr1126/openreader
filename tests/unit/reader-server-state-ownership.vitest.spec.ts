import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('reader server-state ownership', () => {
  test('queries reader startup through one aggregate operation', () => {
    const bootstrap = source('src/hooks/useReaderBootstrap.ts');
    expect(bootstrap).toContain('getReaderBootstrap(documentId!');
    expect(bootstrap).toContain('subscribeReaderBootstrap(documentId');
    expect(bootstrap).not.toContain('refetchInterval');
    expect(bootstrap).not.toContain('useDocumentProgress');
    expect(bootstrap).not.toContain('useDocumentSettings');
    expect(bootstrap).not.toContain('useDocumentMetadata');
    expect(source('src/contexts/TTSContext.tsx')).not.toContain('useDocumentProgress(');
    expect(source('src/hooks/epub/useEPUBLocationController.ts')).not.toContain('useDocumentProgress(');
  });

  test('does not retain per-document startup query hooks', () => {
    expect(existsSync(resolve(root, 'src/hooks/useDocumentMetadata.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/hooks/useDocumentSettings.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/hooks/useDocumentProgress.ts'))).toBe(false);
    expect(source('src/app/(app)/pdf/[id]/usePdfDocument.ts')).not.toContain('useDocumentSettings');
    expect(source('src/app/(app)/epub/[id]/page.tsx')).not.toContain('useDocumentSettings');
    expect(source('src/app/(app)/html/[id]/page.tsx')).not.toContain('useDocumentSettings');
  });

  test('uses one reader loader and aggregate PDF progress', () => {
    expect(existsSync(resolve(root, 'src/components/reader/ReaderPhaseLoader.tsx'))).toBe(false);
    expect(existsSync(resolve(root, 'src/components/reader/PdfLayoutScan.tsx'))).toBe(false);
    const loader = source('src/components/reader/ReaderLoader.tsx');
    const shell = source('src/components/reader/ReaderShell.tsx');
    expect(loader).toContain('progress?: ReaderBootstrapProgress');
    expect(shell).toContain('<ReaderLoader progress={result.progress} />');
    for (const path of [
      'src/app/(app)/pdf/[id]/page.tsx',
      'src/app/(app)/epub/[id]/page.tsx',
      'src/app/(app)/html/[id]/page.tsx',
    ]) {
      expect(source(path)).toContain('<ReaderShell');
      expect(source(path)).not.toContain('ReaderLoader');
    }
  });

  test('centralizes immutable source acquisition and deletes route startup effects', () => {
    const bootstrap = source('src/hooks/useReaderBootstrap.ts');
    const shell = source('src/components/reader/ReaderShell.tsx');
    expect(bootstrap).toContain('progressPersistenceEnabled.current = false');
    expect(bootstrap).toContain('flushProgress()');
    expect(bootstrap).toContain('ensureCachedDocument(sourceMetadata!)');
    expect(bootstrap).toContain('retry: false');
    expect(shell).toContain('initializeReaderSession({');
    expect(existsSync(resolve(root, 'src/hooks/useUnmountCleanupRef.ts'))).toBe(false);

    for (const path of [
      'src/app/(app)/pdf/[id]/page.tsx',
      'src/app/(app)/epub/[id]/page.tsx',
      'src/app/(app)/html/[id]/page.tsx',
    ]) {
      const page = source(path);
      expect(page).not.toContain('loadDocument');
      expect(page).not.toContain('inFlightDocIdRef');
      expect(page).not.toContain('loadedDocIdRef');
      expect(page).not.toContain('setCurrentDocument');
      expect(page).not.toContain('prepareInitialPosition');
      expect(page).not.toContain('acceptBootstrapPlaybackPlan');
      expect(page).not.toContain('useUnmountCleanupRef');
    }
  });

  test('keys renderer sessions to the authoritative bootstrap surface', () => {
    const shell = source('src/components/reader/ReaderShell.tsx');
    const surfaceKey = source('src/lib/client/reader-readiness/surface-key.ts');
    expect(surfaceKey).toContain('payload.plan.planId');
    expect(surfaceKey).toContain('payload.plan.planSignature');
    expect(surfaceKey).toContain('payload.document.contentVersion');
    expect(shell).toContain('const attemptKey = `${surfaceKey}:${rendererAttempt}`');
    expect(shell).toContain('<Fragment key={attemptKey}>');
    expect(source('src/hooks/useReaderSurfaceAdoption.ts'))
      .toContain('claimedAttemptKeyRef.current = input.attemptKey');
    expect(shell).toContain('enableProgressPersistence()');
    for (const path of [
      'src/app/(app)/pdf/[id]/page.tsx',
      'src/app/(app)/epub/[id]/page.tsx',
      'src/app/(app)/html/[id]/page.tsx',
    ]) {
      const page = source(path);
      expect(page).not.toContain('useLatestRef');
      expect(page).not.toContain('useReaderBootstrap');
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
    const readerProgress = source('src/lib/shared/reader-position.ts');
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

  test('commits each renderer through its real initial surface boundary', () => {
    const playbackModel = source('src/hooks/audio/useTtsPlaybackModel.ts');
    expect(playbackModel).toContain('model.selectedOrdinal === null');

    const planController = source('src/hooks/audio/useTtsPlanController.ts');
    expect(planController).toContain('getPlaybackPlan');
    expect(planController).not.toContain('preparedRequestKeyRef');
    expect(planController).not.toContain('requestKeyRef');
    expect(planController).not.toContain('createTtsPlaybackPlan');
    expect(planController).not.toContain('resolveTtsPlaybackPlan');
    expect(planController).not.toContain('fetchPlaybackSeekLayoutUntilReady');
    expect(planController).not.toContain('setTimeout(resolve, 300)');
    expect(playbackModel).toContain('currentPlan.planId === plan.planId');

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
    expect(pdfViewer).toContain("parts.has('canvas')");
    expect(pdfViewer).toContain("parts.has('text')");
    expect(pdfViewer).toContain("parts.has('highlight')");
    expect(pdfViewer).toContain('reportSurfaceCommitError');
    expect(pdfViewer).toContain('playbackPlanSegmentCount === 0');
    expect(pdfViewer).toContain('textLayerReadyLayoutKey !== layoutKey');
    expect(pdfViewer).not.toContain('setTextLayerRenderRevision');
    expect(pdfViewer).not.toContain('onRenderSuccess={() =>');
    expect(pdfViewer).not.toContain('onRenderTextLayerSuccess={() =>');
    expect(pdfViewer).toContain('const layoutKey = `${renderScale}:${viewType}:${currDocPage}`');
    expect(pdfViewer).not.toContain('`${zoomLevel}:${containerWidth}:${containerHeight}');
    expect(pdfViewer).not.toContain('markViewerReady');
    expect(pdfPage).not.toContain('deriveReaderLoadState');
    expect(pdfPage).not.toContain('viewerError');
    expect(pdfPage).not.toContain('await new Promise((resolve) => setTimeout(resolve, 250))');
    expect(pdfHighlighting).toContain('findBestHighlightTokenMatch');
    expect(pdfHighlighting).not.toContain('new Worker(');
    expect(pdfHighlighting).toContain('useBlockGeometryOnly');
    expect(existsSync(resolve(root, 'src/lib/client/pdf-highlight-worker.ts'))).toBe(false);
    const epubPage = source('src/app/(app)/epub/[id]/page.tsx');
    expect(epubPage).toContain('failPlacement(error)');
    expect(epubPage).toContain('onError(error)');
    expect(htmlViewer).not.toContain('scheduleSentence');
    expect(htmlViewer).not.toContain('scheduleWord');
  });
});
