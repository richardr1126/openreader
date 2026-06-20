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

  test('uses centralized query keys for manifests, rate limits, and admin state', () => {
    const sidebar = source('src/components/reader/SegmentsSidebar.tsx');
    const manifestRoute = source('src/app/api/tts/segments/manifest/route.ts');
    expect(sidebar).toContain('queryKeys.ttsManifest');
    expect(sidebar).toContain("params.set('readerType', 'epub')");
    expect(sidebar).toContain("params.set('spineIndex', String(currentEpubSpine.index))");
    expect(sidebar).toContain("params.set('spineHref', currentEpubSpine.href)");
    expect(manifestRoute).toContain("request.nextUrl.searchParams.get('readerType')");
    expect(manifestRoute).toContain("eq(ttsSegmentEntries.locatorReaderType, 'epub')");
    expect(manifestRoute).toContain('eq(ttsSegmentEntries.locatorSpineIndex, spineIndex)');
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
    const workerRoutes = source('packages/compute-worker/src/api/routes.ts');
    expect(context).toContain('createTtsPlaybackSession');
    expect(context).toContain('createTtsPlaybackPlan');
    expect(clientTts).toContain("fetch('/api/tts/playback/plans'");
    expect(clientTts).not.toContain('planOnly');
    expect(sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')).not.toContain('planOnly');
    expect(context).toContain('useTtsPlayback');
    expect(context).toContain('resolvePlaybackStartIndex');
    expect(playbackHook).toContain('normalizePlaybackTimeline');
    expect(playbackHook).toContain('projectTimelineAtTime');
    expect(context).toContain('audio.src = session.audioUrl');
    expect(context).toContain('const hasViewportAnchor = Boolean(playbackAnchorRef.current?.text.trim())');
    expect(context).not.toContain('if (!sentences[currentIndex]) return');
    expect(context).toContain("currentSentence: sentences[currentIndex] || ''");
    expect(context).not.toContain('playbackAnchor:');
    expect(source('src/components/reader/SegmentsSidebar.tsx')).not.toContain('playbackAnchor');
    expect(context).toContain('playbackPlanSource === \'worker\'');
    expect(context).toContain('setPlaybackPlanSource(\'worker\')');
    expect(streamSessionRoute).toContain('audioUrl: buildWorkerAudioUrl');
    expect(streamSessionRoute).not.toContain('planOnly');
    expect(streamSessionRoute).toContain('planObjectKey');
    expect(streamSessionRoute).toContain('startSegmentKey');
    expect(workerRoutes).toContain("/v1/tts-playback/:sessionId/audio");
    expect(workerRoutes).toContain("/v1/tts-playback-plans/operations");
    expect(workerRoutes).toContain('Readable.from(streamRange())');
    // The audio stream is seekable (range-capable + finite Content-Length) so the
    // browser honors post-generation playbackRate, including on Safari.
    expect(workerRoutes).toContain("reply.header('Accept-Ranges', 'bytes')");
    expect(workerRoutes).toContain('parseRangeHeader');
    expect(workerRoutes).toContain('verifyTtsPlaybackToken');
    expect(workerRoutes).toContain('updatePlaybackCursor');
    expect(streamSessionRoute).toContain('const startOrdinal = parsed.startOrdinal ?? 0');
    expect(streamSessionRoute).toContain('...(startPage !== undefined ? { startPage } : {})');
    expect(streamSessionRoute).toContain('...(startSpineIndex !== undefined ? { startSpineIndex } : {})');
    expect(streamSessionRoute).toContain('...(startCharOffset !== undefined ? { startCharOffset } : {})');
    expect(epubHighlighting).toContain('resolveVisibleSegmentRange(renderedTextMapsRef.current, segment)');
    expect(epubHighlighting).not.toContain('segment.startAnchor.sourceKey !== resolved.map.sourceKey');
    // Single forward-generation job throttled to a client cursor; segment
    // discovery is SSE-driven (no polling), and the disconnect-continuation
    // extent comes from the admin ttsPlaybackBackgroundExtent setting.
    expect(streamSessionRoute).toContain('TTS_PLAYBACK_AHEAD_WINDOW');
    expect(streamSessionRoute).toContain('backgroundExtent');
    expect(context).toContain('subscribeTtsPlaybackEvents');
    expect(context).toContain('postTtsPlaybackCursor');
    expect(context).toContain('seekPlaybackTo');
    expect(context).toContain('audio.currentTime = targetSec');
    expect(source('src/app/api/tts/stream/[sessionId]/events/route.ts')).toContain('openOperationEvents');
    expect(source('src/app/api/tts/stream/[sessionId]/cursor/route.ts')).toContain('cursorOrdinal');
    expect(source('src/app/api/tts/playback/plans/[planId]/seek-layout/route.ts')).toContain('buildSeekLayout');
    expect(existsSync(path.join(root, 'src/app/api/tts/stream/[sessionId]/media.m3u8/route.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/lib/client/tts/hls-audio-controller.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/app/api/tts/stream/[sessionId]/extend/route.ts'))).toBe(false);
    expect(streamSessions).toContain('Math.floor(options?.minOrdinal ?? 0)');
    expect(streamSessions).not.toContain('Math.max(session.startOrdinal');
    expect(streamSessions).toContain('readStreamPlanSegments(session)');
    expect(streamSessions).toContain('locatorIdentityKey(plan.locator)');
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
