import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveLayout: vi.fn(),
  readPlan: vi.fn(),
  variants: vi.fn(),
  saved: vi.fn(),
  defaultRequest: vi.fn(),
  scope: vi.fn(),
}));

vi.mock('@/lib/server/pdf-parse/operation', () => ({ resolveCurrentPdfParse: mocks.resolveLayout }));
vi.mock('@/lib/server/tts/playback-plans', () => ({ readTtsPlaybackPlanArtifact: mocks.readPlan }));
vi.mock('@/lib/server/storage/s3', () => ({ getS3Config: () => ({ prefix: 'openreader' }) }));
vi.mock('@/lib/server/documents/blobstore', () => ({
  isMissingBlobError: (error: { name?: string }) => error?.name === 'NoSuchKey',
}));
vi.mock('@/lib/server/compute-worker/client', () => ({
  ComputeWorkerClient: class { listTtsPlaybackCachedVariants = mocks.variants; },
}));
vi.mock('@/lib/server/audiobooks/request', () => ({ loadSavedPlayback: mocks.saved }));
vi.mock('@/lib/server/reader/playback', () => ({ resolveDefaultPlaybackRequest: mocks.defaultRequest }));
vi.mock('@/lib/server/tts/cloned-voices', () => ({ listClonedVoices: async () => [] }));
vi.mock('@/lib/server/tts/segments-auth', () => ({ resolveSegmentDocumentScope: mocks.scope }));

import { buildTtsPlaybackPlanningInput, type ParsedTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';
import { NextRequest } from 'next/server';
import { listCachedVoices } from '@/lib/server/tts/cached-voices';
import { resolveDocumentStorageScope } from '@/lib/server/tts/storage-scope';
import { ttsPlaybackSettingsIdentity } from '@openreader/tts/segments';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

const DOCUMENT_ID = 'a'.repeat(64);
const REVISION = 'c'.repeat(32);
const PLAN_PREFIX = `openreader/tts_playback_plan_v1/${DOCUMENT_ID}/7/pdf/`;
const OLD_PLAN = `${PLAN_PREFIX}${'1'.repeat(32)}.json`;
const NEW_PLAN = `${PLAN_PREFIX}${'2'.repeat(32)}.json`;

const scope = {
  userId: 'user-1', storageUserId: 'user-1', documentVersion: 7, readerType: 'pdf', documentName: 'book.pdf', isAnonymousUser: false,
} as unknown as ResolvedSegmentDocumentScope;

const request = (fields: Partial<ParsedTtsPlaybackRequestBody> = {}): ParsedTtsPlaybackRequestBody => ({
  documentId: DOCUMENT_ID,
  settings: { providerRef: 'kitten', providerType: 'custom-openai', ttsModel: 'KittenTTS', voice: 'Luna', nativeSpeed: 1, language: 'en' },
  startLocation: {},
  skipBlockKinds: ['header', 'footer'],
  ...fields,
});

const currentLayout = (narrationRevision?: string) => mocks.resolveLayout.mockResolvedValue({
  artifact: { objectKey: 'layout.json', ...(narrationRevision ? { narrationRevision } : {}) },
  operation: null,
});

// Computed on upstream 78390594 for `request()`; existing audio is stored under it.
const LEGACY_SETTINGS_HASH = 'eae0148b9e748c26e6ebfa7831d5dbc21610effe3af4e29d44032e9a3eaad955';

beforeEach(() => {
  vi.clearAllMocks();
  currentLayout();
  mocks.readPlan.mockImplementation(async (key: string) => {
    if (key === OLD_PLAN) return { artifact: { documentId: DOCUMENT_ID, settingsHash: 'old', segments: [] } };
    if (key === NEW_PLAN) return { artifact: { documentId: DOCUMENT_ID, settingsHash: 'new', narrationRevision: REVISION, segments: [] } };
    throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
  });
});

describe('PDF playback identity after Force reparse', () => {
  test('a layout without a revision keeps the existing audio identity and plan request', async () => {
    const legacy = await buildTtsPlaybackPlanningInput(request(), scope);
    expect(legacy.settingsHash).toBe(LEGACY_SETTINGS_HASH);
    expect(legacy.planning.documentSource).not.toHaveProperty('narrationRevision');
  });

  test('a reparsed layout with changed narration gets its own plan request and audio', async () => {
    const legacy = await buildTtsPlaybackPlanningInput(request(), scope);
    currentLayout(REVISION);
    const reparsed = await buildTtsPlaybackPlanningInput(request(), scope);
    expect(reparsed.settingsHash).not.toBe(legacy.settingsHash);
    expect(reparsed.planning.documentSource).toMatchObject({ narrationRevision: REVISION });
    // The reader passes the revision of the layout it was given.
    expect(await buildTtsPlaybackPlanningInput(request(), scope, { narrationRevision: REVISION })).toEqual(reparsed);
    expect(await buildTtsPlaybackPlanningInput(request(), scope, { narrationRevision: null })).toEqual(legacy);
  });

  test('a request naming a saved plan keeps that plan\'s audio', async () => {
    const legacy = await buildTtsPlaybackPlanningInput(request(), scope);
    currentLayout(REVISION);
    const reparsed = await buildTtsPlaybackPlanningInput(request(), scope);
    mocks.resolveLayout.mockClear();

    // An open reader or a pinned export made before the reparse.
    expect(await buildTtsPlaybackPlanningInput(request({ planObjectKey: OLD_PLAN }), scope)).toEqual(legacy);
    expect(await buildTtsPlaybackPlanningInput(request({ planObjectKey: NEW_PLAN }), scope)).toEqual(reparsed);
    expect(mocks.resolveLayout).not.toHaveBeenCalled();

    // A cleared plan is planned again from the current layout, and another
    // document's plan is never read.
    const missing = `${PLAN_PREFIX}${'3'.repeat(32)}.json`;
    expect(await buildTtsPlaybackPlanningInput(request({ planObjectKey: missing }), scope)).toEqual(reparsed);
    const foreign = `openreader/tts_playback_plan_v1/${'b'.repeat(64)}/7/pdf/${'2'.repeat(32)}.json`;
    expect(await buildTtsPlaybackPlanningInput(request({ planObjectKey: foreign }), scope)).toEqual(reparsed);
    expect(mocks.readPlan).not.toHaveBeenCalledWith(foreign);
  });

  test('storage and reclaim measure the current settings on every layout without reading it', async () => {
    const legacy = await buildTtsPlaybackPlanningInput(request(), scope);
    const otherVoice = await buildTtsPlaybackPlanningInput(request({ settings: { ...request().settings, voice: 'Kiki' } }), scope);
    currentLayout(REVISION);
    const reparsed = await buildTtsPlaybackPlanningInput(request(), scope);
    expect(ttsPlaybackSettingsIdentity(reparsed.settingsHash)).toBe(legacy.settingsHash);
    expect(ttsPlaybackSettingsIdentity(legacy.settingsHash)).toBe(legacy.settingsHash);
    expect(ttsPlaybackSettingsIdentity(otherVoice.settingsHash)).not.toBe(legacy.settingsHash);

    mocks.scope.mockResolvedValue(scope);
    mocks.resolveLayout.mockClear();
    const body = { ...request(), planning: { skipBlockKinds: ['header', 'footer'] } };
    for (const planObjectKey of [undefined, OLD_PLAN, NEW_PLAN]) {
      const resolved = await resolveDocumentStorageScope(new NextRequest('http://localhost/api/tts/storage/document', {
        method: 'POST', body: JSON.stringify({ ...body, ...(planObjectKey ? { planObjectKey } : {}) }),
      }));
      expect(resolved).toMatchObject({ settingsHash: legacy.settingsHash });
    }
    expect(mocks.resolveLayout).not.toHaveBeenCalled();
    expect(mocks.readPlan).not.toHaveBeenCalled();
  });

  test('other readers never look up a PDF layout', async () => {
    const html = { ...scope, readerType: 'html', documentName: 'page.html' } as ResolvedSegmentDocumentScope;
    const planned = await buildTtsPlaybackPlanningInput(request({ planObjectKey: NEW_PLAN }), html);
    expect(planned.planning.documentSource).not.toHaveProperty('narrationRevision');
    expect(mocks.resolveLayout).not.toHaveBeenCalled();
    expect(mocks.readPlan).not.toHaveBeenCalled();
  });

  test('cached voices list audio for the current layout only', async () => {
    const legacy = await buildTtsPlaybackPlanningInput(request(), scope);
    currentLayout(REVISION);
    const reparsed = await buildTtsPlaybackPlanningInput(request(), scope);
    mocks.saved.mockResolvedValue({ settings: {}, preferences: {}, language: 'en' });
    mocks.defaultRequest.mockResolvedValue(request());
    const settingsJson = { providerRef: 'kitten', ttsModel: 'KittenTTS', voice: 'Luna', nativeSpeed: 1 };
    mocks.variants.mockResolvedValue([
      { settingsHash: legacy.settingsHash, settingsJson, segments: 3, durationMs: 1_000, updatedAt: 1 },
      { settingsHash: reparsed.settingsHash, settingsJson, segments: 1, durationMs: 500, updatedAt: 2 },
    ]);
    const caller = { scope } as never;

    expect(await listCachedVoices(caller, DOCUMENT_ID)).toMatchObject([{ voice: 'Luna', segments: 1 }]);
    currentLayout();
    expect(await listCachedVoices(caller, DOCUMENT_ID)).toMatchObject([{ voice: 'Luna', segments: 3 }]);
    // The worker is asked for the current layout's audio only, before it limits the list.
    expect(mocks.variants.mock.calls.map(([input]) => input.narrationRevision)).toEqual([REVISION, null]);
  });
});
