import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  variants: vi.fn(),
  saved: vi.fn(),
  resolve: vi.fn(),
  plan: vi.fn(),
  clones: vi.fn(),
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  ComputeWorkerClient: class { listTtsPlaybackCachedVariants = mocks.variants; },
}));
vi.mock('@/lib/server/audiobooks/request', () => ({ loadSavedPlayback: mocks.saved }));
vi.mock('@/lib/server/reader/playback', () => ({ resolveDefaultPlaybackRequest: mocks.resolve }));
vi.mock('@/lib/server/tts/playback-request', () => ({ buildTtsPlaybackPlanningInput: mocks.plan }));
vi.mock('@/lib/server/tts/cloned-voices', () => ({ listClonedVoices: mocks.clones }));

import { listCachedVoices } from '@/lib/server/tts/cached-voices';

const caller = { scope: { userId: 'u1', storageUserId: 'u1', documentVersion: 3 } } as never;
const variant = (hash: string, settings: Record<string, unknown>) => ({
  settingsHash: hash, settingsJson: settings, segments: 4, durationMs: 60_000, updatedAt: 10,
});

describe('listCachedVoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saved.mockResolvedValue({ settings: {}, preferences: {}, language: 'en' });
    mocks.clones.mockResolvedValue([{ id: 'clone:abc', name: 'My voice' }]);
    // The planning hash names provider, model, voice and speed, as the real one depends on them.
    mocks.resolve.mockImplementation(async (_doc, _scope, _settings, _prefs, _lang, voice: Record<string, unknown>) => (
      voice.provider === 'gone' ? { error: new Response(null, { status: 400 }) } : voice
    ));
    mocks.plan.mockImplementation(async (request: Record<string, unknown>) => ({
      settingsHash: `${request.provider}|${request.model}|${request.voice}|${request.modelSpeed}`,
    }));
  });

  test('lists only variants a request for that voice and model speed would reuse', async () => {
    mocks.variants.mockResolvedValue([
      variant('kitten|KittenTTS|Luna|1.2', { providerRef: 'kitten', ttsModel: 'KittenTTS', voice: 'Luna', nativeSpeed: 1.2 }),
      variant('openai|tts-1|clone:abc|1', { providerRef: 'openai', ttsModel: 'tts-1', voice: 'clone:abc' }),
      // Made with settings that have since changed (segment length, instructions...).
      variant('stale', { providerRef: 'kitten', ttsModel: 'KittenTTS', voice: 'Kiki', nativeSpeed: 1 }),
      // Its provider can no longer be used.
      variant('gone|m|v|1', { providerRef: 'gone', ttsModel: 'm', voice: 'v' }),
    ]);

    const voices = await listCachedVoices(caller, 'doc');

    expect(mocks.variants).toHaveBeenCalledWith({ storageUserId: 'u1', documentId: 'doc', documentVersion: 3 });
    expect(voices).toEqual([
      { provider: 'kitten', model: 'KittenTTS', voice: 'Luna', name: 'Luna', modelSpeed: 1.2, segments: 4, durationMs: 60_000, updatedAt: 10 },
      { provider: 'openai', model: 'tts-1', voice: 'clone:abc', name: 'My voice', modelSpeed: 1, segments: 4, durationMs: 60_000, updatedAt: 10 },
    ]);
  });

  test('skips loading settings when nothing is cached', async () => {
    mocks.variants.mockResolvedValue([]);
    expect(await listCachedVoices(caller, 'doc')).toEqual([]);
    expect(mocks.saved).not.toHaveBeenCalled();
  });
});
