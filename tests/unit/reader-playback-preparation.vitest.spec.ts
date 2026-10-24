import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveReaderPlayback } from '@/lib/server/reader/playback';
import { buildTtsPlaybackPlanningInput } from '@/lib/server/tts/playback-request';
import type { ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(), voices: vi.fn(), credentials: vi.fn(), completed: vi.fn(), enqueue: vi.fn(), readPlan: vi.fn(),
}));
vi.mock('@openreader/tts/voice-resolution', () => ({ resolveVoices: mocks.voices }));
vi.mock('@/lib/server/admin/resolve-credentials', () => ({ resolveTtsCredentials: mocks.credentials }));
vi.mock('@/lib/server/admin/providers', () => ({
  listAdminProviders: mocks.providers,
}));
vi.mock('@/lib/server/runtime-config', () => ({
  getResolvedRuntimeConfig: async () => ({ defaultTtsProvider: 'kitten', showAllProviderModels: true, computeLimitPolicies: {} }),
}));
vi.mock('@/lib/server/compute-limits/run-admitted', () => ({
  ComputeAdmissionLimitedError: class extends Error {},
  createAdmittedComputeOperation: async (input: { create: () => Promise<unknown> }) => input.create(),
}));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => true,
  ComputeWorkerClient: class { createTtsPlaybackPlanOperation = mocks.enqueue; },
  getComputeWorkerClient: () => ({ listTtsPlaybackScopeCompletedSegments: mocks.completed }),
}));
vi.mock('@/lib/server/tts/playback-plans', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/tts/playback-plans')>(),
  readTtsPlaybackPlanArtifact: mocks.readPlan,
}));

const documentId = 'a'.repeat(64);
const scope = {
  userId: 'user', storageUserId: 'owner', documentId, documentVersion: 1,
  documentName: 'fixture.txt', readerType: 'html', isAnonymousUser: true,
} as ResolvedSegmentDocumentScope;
const preferences = { providerRef: 'kitten', providerType: 'custom-openai', ttsModel: 'KittenTTS', voice: '' };
const request = new NextRequest(`http://localhost/api/documents/${documentId}/reader-bootstrap`);
function plan(segments = [0, 1], readerType = 'html') {
  const artifact = {
    schemaVersion: 1, storageUserId: 'owner', documentId, documentVersion: 1,
    readerType, settingsHash: 'shared-plan-settings',
    segments: segments.map((ordinal) => ({ ordinal, segmentKey: `segment-${ordinal}`,
      text: `This is readable sentence number ${ordinal}.`, locator: readerType === 'pdf' ? { readerType: 'pdf', page: 1 } : { readerType: 'html', location: '1' } })),
  };
  return { artifact, body: JSON.stringify(artifact) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers.mockResolvedValue([{ slug: 'kitten', providerType: 'custom-openai', defaultModel: 'KittenTTS', enabled: true }]);
  mocks.voices.mockResolvedValue(['Bella', 'Jasper']);
  mocks.credentials.mockResolvedValue({ provider: 'custom-openai', apiKey: 'credential-sentinel', baseUrl: 'http://provider.invalid/v1' });
  mocks.enqueue.mockResolvedValue({
    opId: 'plan', status: 'succeeded', result: { planObjectKey: 'plans/fixture.json', planSignature: 'signature', startOrdinal: 0, plannedCount: 2 },
  });
  mocks.readPlan.mockResolvedValue(plan());
  mocks.completed.mockResolvedValue({ segments: [{ ordinal: 0, durationMs: 6_000 }] });
});

describe('bootstrap playback preparation', () => {
  test('uses global PDF skip and segment defaults, then applies independent book overrides', async () => {
    mocks.readPlan.mockResolvedValue(plan([0, 1], 'pdf'));
    const prepare = (settings = DEFAULT_DOCUMENT_SETTINGS) => resolveReaderPlayback(request, documentId,
      { ...scope, readerType: 'pdf' }, settings,
      { ...preferences, ttsSegmentMaxBlockLength: 600, pdfSkipBlockKinds: ['header', 'footer'] });
    await prepare();
    expect(mocks.enqueue.mock.calls.at(-1)?.[0].planning).toMatchObject({ maxBlockLength: 600,
      documentSource: { skipBlockKinds: ['header', 'footer'] } });
    const inheritedHash = mocks.enqueue.mock.calls.at(-1)?.[0].settingsHash;
    await prepare({ ...DEFAULT_DOCUMENT_SETTINGS, playback: { maxSegmentLength: 300 }, pdf: { skipBlockKinds: [] } });
    expect(mocks.enqueue.mock.calls.at(-1)?.[0].planning).toMatchObject({ maxBlockLength: 300,
      documentSource: { skipBlockKinds: [] } });
    expect(mocks.enqueue.mock.calls.at(-1)?.[0].settingsHash).not.toBe(inheritedHash);
    await prepare({ ...DEFAULT_DOCUMENT_SETTINGS, playback: {}, pdf: {} });
    expect(mocks.enqueue.mock.calls.at(-1)?.[0].settingsHash).toBe(inheritedHash);
  });
  test.each([
    ['auto', 'tr-TR', 'F1', 'tr-TR'],
    ['auto', 'de-DE', 'F1', 'de-DE'],
    ['auto', 'en-US', 'F1', 'en'],
    ['auto', 'tr', 'jf_alpha', 'ja'],
    ['de', 'tr', 'jf_alpha', 'de'],
  ])('prepares %s / %s / %s consistently for planning, audio, and export', async (configured, metadata, voice, expected) => {
    const result = await resolveReaderPlayback(request, documentId, scope,
      { ...DEFAULT_DOCUMENT_SETTINGS, language: configured }, { ...preferences, voice }, metadata);
    expect(result).toMatchObject({ playback: { request: {
      settings: { language: expected }, planning: { language: expected },
    } } });
    const workerRequest = mocks.enqueue.mock.calls[0]?.[0];
    expect(workerRequest.planning.language).toBe(expected);
    expect(JSON.parse(workerRequest.settingsJson).language).toBe(expected);
  });

  test('preserves English cache scope but separates corrected non-English audio', async () => {
    const prepare = (language?: string) => resolveReaderPlayback(request, documentId, scope,
      DEFAULT_DOCUMENT_SETTINGS, { ...preferences, voice: 'F1' }, language);
    await prepare();
    const originalHash = mocks.completed.mock.calls.at(-1)?.[0].settingsHash;
    await prepare('en-GB');
    expect(mocks.completed.mock.calls.at(-1)?.[0].settingsHash).toBe(originalHash);
    await prepare('tr-TR');
    expect(mocks.completed.mock.calls.at(-1)?.[0].settingsHash).not.toBe(originalHash);
  });
  test('an unconfigured installation can read with a complete estimated timeline', async () => {
    mocks.providers.mockResolvedValueOnce([]);
    mocks.completed.mockResolvedValueOnce({ segments: [] });
    const result = await resolveReaderPlayback(request, documentId, scope, DEFAULT_DOCUMENT_SETTINGS, {});
    expect(result).toMatchObject({ playback: { seekLayout: { segments: [
      { ordinal: 0, generated: false, estimated: true }, { ordinal: 1, generated: false, estimated: true },
    ] } } });
    if (!('playback' in result)) throw new Error('Expected prepared reading timeline');
    expect(result.playback.seekLayout.durationMs).toBeGreaterThan(0);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.voices).not.toHaveBeenCalled();
  });

  test('a static voice catalogue does not require provider credentials for reading', async () => {
    mocks.providers.mockResolvedValueOnce([{ slug: 'openai-service', providerType: 'openai', defaultModel: 'tts-1', enabled: true }]);
    const result = await resolveReaderPlayback(request, documentId, scope, DEFAULT_DOCUMENT_SETTINGS, {
      providerRef: 'openai-service', providerType: 'openai', ttsModel: 'tts-1', voice: '',
    });
    expect(result).toMatchObject({ playback: { request: { settings: { voice: 'alloy' } } } });
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.voices).not.toHaveBeenCalled();
  });

  test('waits for the matching voice cache before returning a ready timeline', async () => {
    let release!: (value: { segments: Array<{ ordinal: number; durationMs: number }> }) => void;
    mocks.completed.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let settled = false;
    const preparation = resolveReaderPlayback(request, documentId, scope, DEFAULT_DOCUMENT_SETTINGS, preferences)
      .then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(mocks.completed).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    release({ segments: [{ ordinal: 0, durationMs: 6_000 }] });
    const result = await preparation;
    expect('playback' in result).toBe(true);
    if (!('playback' in result)) throw new Error('Expected prepared playback');
    expect(result.playback.request.settings.voice).toBe('Bella');
    expect(result.playback.seekLayout).toMatchObject({ planId: 'plan', segments: [
      { ordinal: 0, generated: true, durationMs: 6_000 }, { ordinal: 1, generated: false },
    ] });
    const parsed = await buildTtsPlaybackPlanningInput({
      documentId, settings: result.playback.request.settings, startLocation: {},
      maxBlockLength: result.playback.request.planning?.maxBlockLength,
      language: result.playback.request.planning?.language,
    }, scope);
    expect(mocks.completed).toHaveBeenCalledWith(expect.objectContaining({
      documentId, storageUserId: 'owner', settingsHash: parsed.settingsHash,
    }));
    expect(JSON.stringify(result)).not.toContain('credential-sentinel');
    expect(JSON.stringify(result)).not.toContain('provider.invalid');
  });

  test('does not turn a failed cache read into an empty successful layout', async () => {
    mocks.completed.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(resolveReaderPlayback(request, documentId, scope, DEFAULT_DOCUMENT_SETTINGS, preferences))
      .rejects.toThrow('storage unavailable');
  });

  test('uses a saved voice without waiting for another voice catalogue', async () => {
    const result = await resolveReaderPlayback(request, documentId, scope, DEFAULT_DOCUMENT_SETTINGS, { ...preferences, voice: 'Jasper' });
    expect(result).toMatchObject({ playback: { request: { settings: { voice: 'Jasper' } } } });
    expect(mocks.voices).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  test('an empty authoritative plan requires no audio cache request', async () => {
    mocks.enqueue.mockResolvedValueOnce({
      opId: 'plan', status: 'succeeded', result: { planObjectKey: 'plans/fixture.json', planSignature: 'signature', startOrdinal: 0, plannedCount: 0 },
    });
    mocks.readPlan.mockResolvedValueOnce(plan([]));
    const result = await resolveReaderPlayback(request, documentId, scope, DEFAULT_DOCUMENT_SETTINGS, preferences);
    expect(result).toMatchObject({ playback: { seekLayout: { durationMs: 0, segments: [] } } });
    expect(mocks.completed).not.toHaveBeenCalled();
  });
});
