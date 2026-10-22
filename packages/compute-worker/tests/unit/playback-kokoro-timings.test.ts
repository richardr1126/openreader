import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { MP3_ENCODER_DELAY_SEC } from '@openreader/tts/audio-format';
import type { TtsPlaybackSegmentMetadata, TtsPlaybackStorage } from '../../src/playback/storage';

const mocks = vi.hoisted(() => ({
  generateTTSBuffer: vi.fn(async () => Buffer.from('provider-mp3')),
  synthesizeKokoro: vi.fn(async () => ({
    wav: Buffer.from('kokoro-wav'),
    words: [
      { word: 'Hello,', start: 0.05, end: 0.4 },
      { word: 'world.', start: 0.45, end: 0.9 },
    ],
  })),
  normalizeToMp3: vi.fn(async () => Buffer.from('kokoro-mp3')),
  runAlignment: vi.fn(),
}));

vi.mock('@openreader/tts/generate', () => ({ generateTTSBuffer: mocks.generateTTSBuffer }));
vi.mock('@openreader/tts/audio-format', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openreader/tts/audio-format')>(),
  normalizeToMp3: mocks.normalizeToMp3,
}));
vi.mock('@openreader/tts/segments', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openreader/tts/segments')>(),
  probeAudioDurationMsFromBuffer: vi.fn(async () => 1_000),
}));
vi.mock('../../src/inference/kokoro/engine', () => ({
  prepareKokoro: vi.fn(async () => undefined),
  synthesizeKokoro: mocks.synthesizeKokoro,
}));
vi.mock('../../src/inference/runtime', () => ({ runWhisperAlignmentFromAudioBuffer: mocks.runAlignment }));
vi.mock('../../src/jobs/tts-credential-broker', () => ({
  resolveTtsCredentialsFromBroker: vi.fn(async () => ({
    providerRef: 'kokoro-local',
    providerType: 'kokoro-local',
    apiKey: '',
    baseUrl: null,
    defaultModel: 'kokoro',
    defaultInstructions: null,
  })),
}));

describe('local Kokoro segment timing', () => {
  beforeAll(async () => {
    await import('../../src/jobs/playback/segment-generation');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('stores the model\'s own word timings with the audio and never runs Whisper', async () => {
    let sidecar: TtsPlaybackSegmentMetadata | null = null;
    const writes: TtsPlaybackSegmentMetadata[] = [];
    const putAudioObject = vi.fn(async () => undefined);
    const { generateExplicitTtsPlaybackSegments } = await import('../../src/jobs/playback/segment-generation');
    await generateExplicitTtsPlaybackSegments({
      request: {
        sessionId: 'session-1', userId: 'user-1', storageUserId: 'user-1', documentId: 'document-1',
        documentVersion: 1, readerType: 'html', settingsHash: 'settings-1', planObjectKey: 'plan-key',
        generationExtent: 'window', planning: {},
        settingsJson: { providerRef: 'kokoro-local', providerType: 'kokoro-local', ttsModel: 'kokoro',
          voice: 'af_heart', nativeSpeed: 1.2, ttsInstructions: '', language: 'en' },
      },
      sessionInstanceId: 'instance-1', s3Prefix: 'openreader',
      segments: [{ ordinal: 3, text: 'Hello, world.', locator: { readerType: 'html', location: '1' } }],
      putAudioObject, audioObjectExists: vi.fn(async () => false),
      playbackStorage: { artifacts: {
        readSegmentMetadata: async () => sidecar,
        putSegmentMetadata: async (metadata: TtsPlaybackSegmentMetadata) => {
          sidecar = metadata;
          writes.push(metadata);
          return 'sidecar';
        },
        getScopeEpoch: async () => 0,
      } } as unknown as TtsPlaybackStorage,
      synthesisTimeoutMs: 30_000,
    });

    expect(mocks.synthesizeKokoro).toHaveBeenCalledWith(
      { text: 'Hello, world.', voice: 'af_heart', speed: 1.2 },
      expect.any(AbortSignal),
    );
    expect(mocks.generateTTSBuffer).not.toHaveBeenCalled();
    expect(putAudioObject).toHaveBeenCalledWith(expect.any(String), Buffer.from('kokoro-mp3'));
    expect(mocks.runAlignment).not.toHaveBeenCalled();

    // The first completed write already carries the timings, moved by the
    // MP3 encoder's delay so they match the stored audio.
    const completed = writes.find((write) => write.status === 'completed');
    expect(completed?.alignment).toMatchObject({
      sentence: 'Hello, world.',
      sentenceIndex: 3,
      words: [
        { text: 'Hello,', charStart: 0, charEnd: 6 },
        { text: 'world.', charStart: 7, charEnd: 13 },
      ],
    });
    const words = completed!.alignment!.words;
    expect(words[0]!.startSec).toBeCloseTo(0.05 + MP3_ENCODER_DELAY_SEC);
    expect(words[1]!.endSec).toBeCloseTo(0.9 + MP3_ENCODER_DELAY_SEC);
  });
});
