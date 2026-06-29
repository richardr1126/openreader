import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const srcRoot = path.join(root, 'src');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      files.push(...collectSourceFiles(fullPath));
    } else if (sourceExtensions.has(path.extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('server-state architecture', () => {
  const sourceFiles = collectSourceFiles(srcRoot);

  test('has no Dexie or RxDB runtime imports or migration UI', () => {
    const forbiddenPatterns: Array<{ label: string; regex: RegExp }> = [
      { label: 'dexie import', regex: /\bfrom\s+['"]dexie(?:\/[^'"]*)?['"]/i },
      { label: 'dexie require', regex: /require\(\s*['"]dexie(?:\/[^'"]*)?['"]\s*\)/i },
      { label: 'rxdb import', regex: /\bfrom\s+['"]rxdb(?:\/[^'"]*)?['"]/i },
      { label: 'rxdb require', regex: /require\(\s*['"]rxdb(?:\/[^'"]*)?['"]\s*\)/i },
      { label: 'Dexie class reference', regex: /\bnew\s+Dexie\b/ },
      { label: 'migration modal test id', regex: /migration-(?:modal|skip-button)/ },
    ];
    const offenders = sourceFiles.flatMap((file) => {
      const contents = readFileSync(file, 'utf8');
      return forbiddenPatterns
        .filter(({ regex }) => regex.test(contents))
        .map(({ label }) => `${path.relative(root, file)}: ${label}`);
    });

    expect(offenders).toEqual([]);
  });

  test('has no Dexie or RxDB package dependencies', () => {
    const pkg = JSON.parse(source('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    expect(Object.keys(dependencies)).not.toContain('dexie');
    expect(Object.keys(dependencies)).not.toContain('rxdb');
  });

  test('does not persist React Query state', () => {
    const forbiddenPersistence = [
      'PersistQueryClientProvider',
      'persistQueryClient',
      'createSyncStoragePersister',
      'createAsyncStoragePersister',
    ];
    const offenders = sourceFiles.flatMap((file) => {
      const contents = readFileSync(file, 'utf8');
      return forbiddenPersistence
        .filter((pattern) => contents.includes(pattern))
        .map((pattern) => `${path.relative(root, file)}: ${pattern}`);
    });

    expect(offenders).toEqual([]);
  });

  test('uses centralized query-key factories', () => {
    const rawKeyPattern = /queryKey:\s*\[\s*['"`]/;
    const offenders = sourceFiles
      .filter((file) => rawKeyPattern.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual([]);
  });

  test('keeps localStorage limited to theme and analytics consent', () => {
    const localStorageCall = /\blocalStorage\.(?:getItem|setItem|removeItem|clear)\s*\(/;
    const allowed = new Set([
      'src/app/layout.tsx',
      'src/contexts/ThemeContext.tsx',
      'src/lib/client/analytics.ts',
    ]);
    const offenders = sourceFiles
      .filter((file) => localStorageCall.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
      .filter((file) => !allowed.has(file));

    expect(offenders).toEqual([]);
  });

  test('keeps audiobook status and chapter mutations in the audiobook query hook', () => {
    const modal = source('src/components/AudiobookExportModal.tsx');
    expect(modal).toContain('useAudiobookStatus(documentId');
    expect(modal).not.toContain('getAudiobookStatus');
    expect(modal).not.toContain('setChapters');
    expect(modal).not.toContain('setBookId');
  });

  test('keeps parsed PDF server state and SSE cache updates in the parsed-document query hook', () => {
    const pdf = source('src/app/(app)/pdf/[id]/usePdfDocument.ts');
    const parsedDocumentHook = source('src/hooks/useParsedPdfDocument.ts');
    expect(pdf).toContain('useParsedPdfDocument(documentId)');
    expect(pdf).not.toContain('subscribeParsedPdfDocumentEvents');
    expect(parsedDocumentHook).toContain('queryKeys.parsedDocument');
    expect(parsedDocumentHook).toContain('queryClient.setQueryData<ParsedPdfQueryState>');
  });

  test('loads TTS voice metadata and claims through centralized query hooks', () => {
    const voiceHook = source('src/hooks/audio/useVoiceManagement.ts');
    expect(voiceHook).toContain('queryKeys.ttsVoices');
    expect(voiceHook).toContain('resolveTtsProviderModelPolicy');
    expect(source('src/components/auth/ClaimDataModal.tsx')).toContain('useClaimData(false)');
    expect(source('src/contexts/OnboardingFlowContext.tsx')).toContain('useClaimData(');
  });

  test('keeps legacy TTS manifest queries removed while centralizing other server state', () => {
    // The segments sidebar (the last legacy-manifest consumer) was removed; its
    // only surviving capability — clearing cached audio — moved to reader settings.
    expect(existsSync(path.join(root, 'src/components/reader/SegmentsSidebar.tsx'))).toBe(false);
    expect(sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')).not.toContain('queryKeys.ttsManifest');
    expect(sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')).not.toContain('/api/tts/segments/manifest');
    expect(source('src/components/documents/DocumentSettings.tsx')).toContain("'/api/tts/segments/clear'");
    expect(source('src/contexts/AuthRateLimitContext.tsx')).toContain('queryKeys.rateLimit');
    expect(source('src/components/admin/AdminProvidersPanel.tsx')).toContain('queryKeys.admin(sessionId');
  });

  test('drives TTS playback through worker-owned progressive streams', () => {
    const context = source('src/contexts/TTSContext.tsx');
    const clientTts = source('src/lib/client/api/tts.ts');
    const playbackHook = source('src/hooks/audio/useTtsPlayback.ts');
    const epubHighlighting = source('src/hooks/epub/useEPUBHighlighting.ts');
    const streamSessionRoute = source('src/app/api/tts/stream/sessions/route.ts');
    const streamSessions = source('src/lib/server/tts/playback-sessions.ts');
    const streamTimelineRoute = source('src/app/api/tts/stream/[sessionId]/timeline/route.ts');
    const seekLayoutRoute = source('src/app/api/tts/playback/plans/[planId]/seek-layout/route.ts');
    const workerRoutes = source('packages/compute-worker/src/api/routes.ts');
    const workerSchemas = source('packages/compute-worker/src/api/schemas.ts');
    const workerContracts = source('packages/compute-worker/src/operations/contracts.ts');
    const workerKeys = source('packages/compute-worker/src/operations/keys.ts');
    const computeGenerated = source('src/lib/server/compute-worker/generated.ts');
    const adminFeatures = source('src/components/admin/AdminFeaturesPanel.tsx');
    const playbackPlan = source('src/lib/client/tts/playback-plan.ts');
    const playbackGrid = source('src/lib/client/tts/playback-grid.ts');
    const playbackModel = source('src/hooks/audio/useTtsPlaybackModel.ts');
    const ttsApi = source('src/lib/client/api/tts.ts');
    const pdfPage = source('src/app/(app)/pdf/[id]/page.tsx');
    expect(playbackHook).toContain('createTtsPlaybackSession');
    expect(context).toContain('createTtsPlaybackPlan');
    expect(context).toContain('fetchPlaybackSeekLayoutUntilReady');
    expect(playbackHook).toContain('getTtsPlaybackSeekLayout(session.seekLayoutUrl');
    expect(context).toContain('applyPlaybackPlan(plan)');
    expect(clientTts).toContain("fetch('/api/tts/playback/plans'");
    expect(clientTts).not.toContain('planOnly');
    expect(sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')).not.toContain('planOnly');
    expect(context).toContain('useTtsPlayback');
    expect(context).toContain('useTtsPlaybackModel');
    expect(context).toContain('resolvePlanBackedSelectionIndex');
    expect(playbackModel).toContain('playbackPlanToCanonicalSegments');
    expect(playbackModel).toContain('selectedOrdinal');
    expect(playbackHook).toContain('TtsPlaybackPhase');
    expect(playbackHook).toContain("'planning'");
    expect(playbackHook).toContain("'buffering'");
    expect(playbackHook).toContain('normalizePlaybackGrid');
    expect(playbackHook).toContain('projectPlaybackGridAtTime');
    expect(playbackHook).toContain('audio.src = session.audioUrl');
    expect(context).toContain('canStartPlayback: isPlaying &&');
    expect(context).not.toContain("activeReaderType === 'epub' && sentence.trim()");
    expect(context).not.toContain("activeReaderType !== 'epub' && playbackSegment?.key");
    expect(context).toContain("activeReaderType === 'pdf' && pdfSkipBlockKinds ? { skipBlockKinds: pdfSkipBlockKinds }");
    expect(clientTts).toContain('skipBlockKinds?: ParsedPdfBlockKind[]');
    expect(source('src/lib/server/tts/playback-request.ts')).toContain('readOptionalSkipBlockKinds(planningRec)');
    expect(source('src/lib/server/tts/playback-request.ts')).toContain('parsed.skipBlockKinds ?? await getDocumentSkipBlockKinds');
    expect(context).toContain('isStableEpubLocator(anchor?.locator)');
    expect(context).not.toContain('playbackSegment?.ownerLocator');
    expect(context).toContain('charOffset,');
    expect(source('src/app/(app)/epub/[id]/useEpubDocument.ts')).not.toContain('buildEpubCanonicalWindow');
    expect(source('src/app/(app)/epub/[id]/useEpubDocument.ts')).not.toContain('canonicalWindow');
    expect(source('src/app/(app)/epub/[id]/useEpubDocument.ts')).not.toContain('startLocator: canonicalWindow.segments[0]?.ownerLocator');
    expect(source('src/app/(app)/pdf/[id]/usePdfDocument.ts')).toContain('setDocumentPlaybackAnchor(currDocPageNumber, Boolean(text.trim()))');
    expect(pdfPage).toContain('void updateDocumentSettings(nextSettings).then(() => {');
    expect(pdfPage).toContain('reads it from the document-settings row, so wait for persistence');
    expect(source('src/app/(app)/pdf/[id]/usePdfDocument.ts')).not.toContain('setTTSText(text');
    expect(source('src/app/(app)/html/[id]/useHtmlDocument.ts')).toContain('setDocumentPlaybackAnchor(1, true');
    expect(source('src/app/(app)/html/[id]/useHtmlDocument.ts')).not.toContain('setText: setTTSText');
    expect(source('src/app/(app)/html/[id]/useHtmlDocument.ts')).not.toContain('setTTSText(currDocText)');
    expect(context).not.toContain('if (!sentences[currentIndex]) return');
    expect(context).toContain('currentSentence,');
    expect(context).not.toContain('playbackAnchor:');
    expect(context).toContain('playbackPlanSource === \'worker\'');
    expect(context).not.toContain('setPlaybackPlanSource');
    expect(context).not.toContain('setPlaybackSegments');
    expect(context).not.toContain('setSentences');
    expect(streamSessionRoute).toContain('audioUrl: buildWorkerAudioUrl');
    expect(streamSessionRoute).not.toContain('planOnly');
    expect(streamSessionRoute).toContain('planObjectKey');
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain('startSegmentKey');
    expect(workerRoutes).toContain("/v1/tts-playback/:sessionId/audio");
    expect(workerRoutes).toContain("/v1/tts-playback-plans/operations");
    expect(workerRoutes).toContain('Readable.from(streamRange())');
    // The audio stream is seekable (range-capable + finite Content-Length) so the
    // browser honors post-generation playbackRate, including on Safari.
    expect(workerRoutes).toContain("reply.header('Accept-Ranges', 'bytes')");
    expect(workerRoutes).toContain('parseRangeHeader');
    expect(workerRoutes).toContain('verifyTtsPlaybackToken');
    expect(workerRoutes).toContain('updatePlaybackCursor');
    // The scaffolding-silence floor follows the cursor via the shared helper (so
    // it cannot drift from the worker's generation floor → no bytes=0- hang), and
    // a seek request pins the floor to its own race-proof start ordinal. The
    // completed-audio check must still precede the silence branch so existing
    // audio below the floor is served, never silenced.
    expect(workerRoutes).toContain('generationFloorForCursor');
    expect(workerRoutes).toContain('const rangeStartOrdinal = startLoc ? mapLayout.slots[startLoc.slotIndex].segmentIndex : 0');
    expect(workerRoutes).toContain('rangeStartOrdinal > 0 ? rangeStartOrdinal : session.cursorOrdinal');
    expect(workerRoutes).toContain('if (ordinal < silenceFloor)');
    expect(workerRoutes).not.toContain('if (ordinal < session.generationStartOrdinal)');
    expect(workerRoutes.indexOf("if (segmentState.status === 'completed')")).toBeLessThan(
      workerRoutes.indexOf('if (ordinal < silenceFloor)'),
    );
    expect(streamSessionRoute).not.toContain('parsed.startOrdinal');
    expect(streamSessionRoute).not.toContain('generationCursorOrdinal');
    expect(streamSessionRoute).not.toContain('startOrdinal: 0,');
    expect(streamSessionRoute).not.toContain('generationStartOrdinal: 0');
    expect(streamSessionRoute).not.toContain('cursorOrdinal: 0');
    expect(streamSessionRoute).toContain('expiresAt,');
    expect(workerSchemas).not.toContain('startOrdinal: z.number().int().nonnegative().default(0)');
    expect(workerContracts).not.toContain('startOrdinal: number;\n  planObjectKey?: string;');
    expect(workerContracts).not.toContain('startOrdinal: number;\n  planning: TtsPlaybackJobRequest');
    expect(workerKeys).not.toContain('String(input.startOrdinal)');
    expect(computeGenerated).not.toContain('startOrdinal: number;\n                        planObjectKey?: string;');
    expect(computeGenerated).not.toContain('startOrdinal: number;\n                        planning:');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).toContain('const isContinuationRun = Boolean(parsed.generationRunId)');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).toContain('cursorOrdinal: isContinuationRun ? sessionCursorOrdinal : startOrdinal');
    // Generation centers on the cursor via the same shared floor helper as the
    // stream's silence boundary: a fresh run uses the resolved start, a
    // continuation follows the (possibly seeked-backward) cursor — no clamp to
    // the original start.
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).toContain(
      'generationFloorForCursor(\n          isContinuationRun ? sessionCursorOrdinal : startOrdinal,\n        )',
    );
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).toContain('segment.segmentIndex >= generationFloor');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).not.toContain('segment.segmentIndex >= startOrdinal');
    // A run abandons ordinals that fell below the live floor (forward seek) so a
    // continuation re-anchors at the cursor instead of grinding through the gap.
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).toContain('if (planOrdinal < generationFloorForCursor(cursor.cursorOrdinal))');
    // The stream re-anchors generation to the ordinal it is blocked on so the
    // continuation starts promptly after a seek (not at the next heartbeat).
    expect(workerRoutes).toContain('await updatePlaybackCursor(sessionId, ordinal).catch((error) => {');
    expect(workerRoutes).toContain('tts.playback.cursor_reanchor_failed');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).toContain('status: \'running\',\n          planObjectKey,\n          generationStartOrdinal');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).not.toContain('status: \'running\',\n        lastError: null');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).not.toContain('planObjectKey,\n          startOrdinal,\n          generationStartOrdinal');
    expect(workerRoutes).toContain('const startOrdinal = 0;');
    expect(streamTimelineRoute).toContain('startOrdinal: 0');
    expect(seekLayoutRoute).toContain('const startOrdinal = 0;');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).not.toContain('startOrdinal, cursorOrdinal: startOrdinal');
    expect(source('src/lib/server/tts/playback-request.ts')).toContain("typeof rec.nativeSpeed !== 'number'");
    expect(source('src/lib/server/tts/playback-request.ts')).toContain("readOptionalInt(startRec, 'page', 1)");
    expect(source('src/lib/server/tts/playback-request.ts')).toContain("const planExtent = 'document'");
    expect(source('src/lib/server/tts/playback-request.ts')).toContain('selectedOrdinal: parsed.startIntent.selectedOrdinal');
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain('startPage:');
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain("return 'EPUB playback start requires stable spine coordinates'");
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain("scope.readerType === 'epub' ? { startSpineIndex: parsed.startLocation.spineIndex }");
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain("startSpineIndex: parsed.startLocation.spineIndex ?? 0");
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain('startSegmentKey');
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain('startText');
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).not.toContain("throw new Error('EPUB playback start requires stable spine coordinates')");
    expect(source('packages/compute-worker/src/jobs/handlers.ts')).not.toContain('if (planning.startText)');
    expect(epubHighlighting).toContain('resolveVisibleSegmentRange(renderedTextMapsRef.current, segment)');
    expect(epubHighlighting).not.toContain('segment.startAnchor.sourceKey !== resolved.map.sourceKey');
    // Single forward-generation job throttled to a client cursor; segment
    // discovery is SSE-driven (no polling), and the disconnect-continuation
    // extent comes from the admin ttsPlaybackBackgroundExtent setting.
    expect(streamSessionRoute).toContain('TTS_PLAYBACK_AHEAD_WINDOW');
    expect(streamSessionRoute).toContain('backgroundExtent');
    expect(playbackHook).toContain('subscribeTtsPlaybackEvents');
    expect(playbackHook).toContain('postTtsPlaybackCursor');
    // The heartbeat cursor is the playhead's projected ordinal (the same value
    // that drives the highlight), held in playbackCursorOrdinalRef. It must NOT
    // be re-derived from derived UI indexes. `null` => no faithful playhead yet → skip.
    expect(playbackHook).toContain('const cursorOrdinal = playbackCursorOrdinalRef.current');
    expect(playbackHook).toContain('if (cursorOrdinal == null) return');
    expect(playbackHook).toContain('const cursor = Math.max(0, cursorOrdinal)');
    expect(context).not.toContain('const currentSegment = playbackSegmentsRef.current[currentIndexRef.current]');
    expect(playbackHook).toContain('playbackCursorOrdinalRef.current = targetOrdinal');
    expect(context).toContain('const pdfLocatorPage = (locator: TTSSegmentLocator | null | undefined): number | null =>');
    expect(context).toContain('return isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;');
    expect(context).toContain('const pdfAnchorPage = (location: TTSLocation | undefined): number | null =>');
    expect(context).toContain("return typeof location === 'number' && Number.isFinite(location)");
    expect(context).toContain('return pdfLocatorPage(segment.ownerLocator) === targetPage;');
    expect(context).toContain('const page = pdfAnchorPage(location);');
    expect(context).toContain('const page = pdfAnchorPage(anchor?.location) ?? pdfAnchorPage(currDocPageNumber);');
    expect(context).not.toContain('Math.max(1, Math.floor(Number(location) || 1))');
    expect(context).not.toContain('Number(anchor?.location');
    expect(context).toContain('const page = pdfLocatorPage(locator);');
    expect(context).toContain('const page = pdfLocatorPage(targetLocator);');
    expect(context).toContain("if (activeReaderType === 'pdf' || activeReaderType === 'html') {\n        playbackSyncNavigationRef.current = false;");
    // Cursor-follow swallow is independent of play state (paused skip follows the
    // page exactly like playback), so the consume sites no longer gate on
    // playbackActiveRef.
    expect(context).toContain('if (playbackSyncNavigationRef.current) {\n      playbackSyncNavigationRef.current = false;\n      setIsProcessing(false);\n      return;\n    }');
    expect(context).not.toContain('playbackSyncNavigationRef.current && playbackActiveRef.current');
    expect(playbackHook).toContain('const page = isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;');
    expect(playbackHook).not.toContain('const normalizePdfPage = (page: unknown): number | null =>');
    expect(playbackHook).not.toContain("normalizePdfPage((locator as { page?: unknown }).page)");
    expect(playbackPlan).toContain('normalizeLocator(row.locator as TTSSegmentLocator)');
    expect(playbackGrid).toContain('normalizeLocator(row.locator as TTSSegmentLocator)');
    expect(ttsApi).toContain('normalizeLocator(row.locator as TTSSegmentLocator)');
    expect(ttsApi).toContain('locator: TTSSegmentLocator | null');
    expect(ttsApi).not.toContain('locator: unknown');
    const abortAudioBody = context.slice(
      context.indexOf('const abortAudio = useCallback'),
      context.indexOf('/**\n   * Pauses the current audio playback while preserving seek position.'),
    );
    expect(abortAudioBody).not.toContain('playbackPlanRef.current = null');
    expect(abortAudioBody).not.toContain('setPlaybackSeekLayout(null)');
    expect(context).toContain("if (activeReaderType === 'pdf' || activeReaderType === 'html')");
    expect(context).toContain('resolveFirstPlanIndexForDocumentAnchor(');
    expect(playbackHook).toContain('seekPlaybackTo');
    expect(playbackHook).toContain('audio.currentTime = targetSec');
    expect(playbackHook).toContain('const targetOrdinal = projection.segment.ordinal;');
    expect(playbackHook).toContain('setSelectedOrdinal(targetOrdinal)');
    expect(playbackHook).not.toContain('ordinalIndexCacheRef');
    expect(playbackHook).not.toContain('ordinalIndexCache.byOrdinal.get(targetOrdinal) ?? -1');
    expect(playbackHook).not.toContain('segment.key === segmentKey');
    expect(playbackHook).not.toContain('projection.segment.sourceSegmentIndex ?? projection.segment.ordinal');
    expect(adminFeatures).toContain('ttsPlaybackBackgroundExtent');
    expect(adminFeatures).toContain('PLAYBACK_BACKGROUND_EXTENT_OPTIONS');
    expect(context).not.toContain('restartPlaybackSessionFromCurrentPosition');
    expect(playbackModel).toContain('const setSelectedOrdinal = useCallback((ordinal: number | null) =>');
    expect(playbackModel).not.toContain('setPlaybackIndex');
    expect(playbackModel).not.toContain('currentIndexRef');
    expect(context).not.toContain('setPlaybackIndex');
    expect(context).toContain('stopAndPlayFromOrdinal');
    expect(context).toContain('playFromOrdinal');
    expect(context).not.toContain('stopAndPlayFromIndex');
    expect(context).not.toContain('playFromSegment');
    expect(context).toContain('currentSentenceOrdinal');
    expect(playbackHook).toContain("layout?.status === 'running' || layout?.status === 'succeeded'");
    expect(playbackHook).toContain('initialSeekLayout.generationStartOrdinal');
    expect(context).not.toContain('return last');
    expect(context).not.toContain('?? initialSeekLayout.segments[0]');
    expect(source('src/components/player/TTSPlayer.tsx')).toContain('scrubberTrackBackground');
    expect(source('src/components/player/TTSPlayer.tsx')).toContain('segment.generated ? ready : estimated');
    expect(context).toContain('playbackSyncNavigationRef');
    expect(context).toContain('syncPlaybackLocator');
    expect(context).toContain("throw new Error('TTS playback plan did not contain a plan-backed selection for the current anchor')");
    expect(context).not.toContain('startOrdinal: startSegment.ordinal');
    expect(source('src/lib/client/api/tts.ts')).not.toContain('startOrdinal?: number');
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain('startOrdinal?: number');
    expect(source('src/lib/server/tts/playback-request.ts')).not.toContain("readOptionalInt(rec, 'startOrdinal'");
    expect(ttsApi).toContain("throw new Error('TTS playback seek layout response was missing required numeric fields')");
    expect(source('src/app/api/tts/stream/[sessionId]/events/route.ts')).toContain('openOperationEvents');
    expect(source('src/app/api/tts/stream/[sessionId]/cursor/route.ts')).toContain('cursorOrdinal');
    expect(source('src/app/api/tts/playback/plans/[planId]/seek-layout/route.ts')).toContain('buildPlaybackGrid');
    expect(streamTimelineRoute).toContain('buildPlaybackGrid');
    expect(streamTimelineRoute).toContain("throw new Error('TTS playback timeline requires a canonical plan artifact')");
    expect(streamTimelineRoute).toContain('segments: layout.segments');
    expect(streamTimelineRoute).toContain('completedSegments');
    expect(source('src/app/api/tts/playback/plans/[planId]/seek-layout/route.ts')).toContain('segments: layout.segments');
    expect(streamTimelineRoute).not.toContain('let cursorMs');
    expect(existsSync(path.join(root, 'src/app/api/tts/stream/[sessionId]/media.m3u8/route.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/lib/client/tts/hls-audio-controller.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/app/api/tts/stream/[sessionId]/extend/route.ts'))).toBe(false);
    expect(streamSessions).toContain('Math.floor(options?.minOrdinal ?? 0)');
    expect(streamSessions).not.toContain('Math.max(session.startOrdinal');
    expect(streamSessions).not.toContain('readStreamPlanSegments(session)');
    expect(streamSessions).not.toContain('locatorIdentityKey(plan.locator)');
    expect(streamSessions).toContain('getComputeWorkerClient().listTtsPlaybackSegments');
    expect(streamSessions).toContain('return result.segments.map((segment) => ({');
    expect(context).not.toContain('plannedSegmentsByLocationRef');
    expect(context).not.toContain('pendingNextLocationRef');
    expect(existsSync(path.join(root, 'src/lib/client/cache/audio.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/lib/client/tts/audio-warm-cache.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/lib/client/pdf-tts-planning.ts'))).toBe(false);
  });

  test('keeps Cache Storage best-effort and admits only successful full responses', () => {
    const cache = source('src/lib/client/cache/blob-cache.ts');
    expect(cache).toContain("const BLOB_CACHE_NAME = 'openreader-blobs-v1'");
    expect(cache).toContain('response.status === 200');
    expect(cache).toContain("response.type !== 'opaque'");
    expect(cache).toContain("!response.headers.has('Content-Range')");
    expect(cache).toContain('.catch(() => {})');
  });

  test('has no user-BYOK runtime switch or client settings input', () => {
    expect(source('src/lib/server/admin/settings.ts')).not.toContain('restrictUserApiKeys');
    expect(source('src/contexts/RuntimeConfigContext.tsx')).not.toContain('restrictUserApiKeys');
    expect(source('src/lib/client/settings/tts-settings.ts')).not.toContain('apiKey');
    expect(source('src/components/admin/AdminFeaturesPanel.tsx')).not.toContain('Restrict user API keys');
  });

  test('resolves TTS credentials only from admin-managed shared providers', () => {
    const resolver = source('src/lib/server/admin/resolve-credentials.ts');
    expect(resolver).toContain('Only admin-managed shared providers can supply credentials');
    expect(resolver).toContain('decryptedKeyFor(admin)');
  });
});
