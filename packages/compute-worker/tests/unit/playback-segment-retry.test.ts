import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TtsPlaybackSegmentMetadata, TtsPlaybackStorage } from '../../src/playback/storage';
import { ProviderCapacityWaitTimeoutError } from '../../src/jobs/provider-capacity';

const mocks = vi.hoisted(() => ({
  generateTTSBuffer: vi.fn<(request?: unknown, signal?: AbortSignal) => Promise<Buffer>>(),
}));

vi.mock('@openreader/tts/generate', () => ({
  generateTTSBuffer: mocks.generateTTSBuffer,
}));

vi.mock('@openreader/tts/segments', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openreader/tts/segments')>(),
  probeAudioDurationMsFromBuffer: vi.fn(async () => 1_000),
}));

vi.mock('../../src/inference/runtime', () => ({
  runWhisperAlignmentFromAudioBuffer: vi.fn(async () => ({ alignments: [] })),
}));

vi.mock('../../src/jobs/tts-credential-broker', () => ({
  resolveTtsCredentialsFromBroker: vi.fn(async () => ({
    providerRef: 'local-kokoro',
    providerType: 'custom-openai',
    apiKey: 'not-required',
    baseUrl: 'http://127.0.0.1:8880/v1',
    defaultModel: 'kokoro',
    defaultInstructions: null,
  })),
}));

function errorSidecar(): TtsPlaybackSegmentMetadata {
  return {
    schemaVersion: 1,
    status: 'error',
    storageUserId: 'user-1',
    documentId: 'document-1',
    documentVersion: 1,
    readerType: 'html',
    settingsHash: 'settings-1',
    ordinal: 0,
    segmentKey: 'segment-0',
    textHash: 'hash',
    textLength: 10,
    audioKey: 'audio-key',
    audioFormat: 'mp3',
    durationMs: null,
    alignment: null,
    error: { message: 'fetch failed' },
    updatedAt: 1,
  };
}

async function generate(input: {
  sidecar: TtsPlaybackSegmentMetadata | null;
  retryErroredSegments?: boolean;
  acquireProviderCapacity?: () => Promise<() => Promise<void>>;
}) {
  let sidecar = input.sidecar;
  const playbackStorage = {
    artifacts: {
      readSegmentMetadata: vi.fn(async () => sidecar),
      putSegmentMetadata: vi.fn(async (metadata: TtsPlaybackSegmentMetadata) => {
        sidecar = metadata;
        return 'sidecar-key';
      }),
      getScopeEpoch: vi.fn(async () => 0),
    },
  } as unknown as TtsPlaybackStorage;
  const onSegmentCompleted = vi.fn(async () => undefined);
  const onSegmentErrored = vi.fn(async () => undefined);
  const { generateExplicitTtsPlaybackSegments } = await import('../../src/jobs/playback/segment-generation');
  await generateExplicitTtsPlaybackSegments({
    request: {
      sessionId: 'session-1',
      userId: 'user-1',
      storageUserId: 'user-1',
      documentId: 'document-1',
      documentVersion: 1,
      readerType: 'html',
      settingsHash: 'settings-1',
      settingsJson: {
        providerRef: 'local-kokoro',
        providerType: 'custom-openai',
        ttsModel: 'kokoro',
        voice: 'af_heart',
        nativeSpeed: 1,
        ttsInstructions: '',
        language: 'en',
      },
      planning: {},
      planObjectKey: 'plan-key',
      generationExtent: 'document',
    },
    sessionInstanceId: 'instance-1',
    s3Prefix: 'openreader',
    segments: [{
      ordinal: 0,
      segmentKey: 'segment-0',
      text: 'Retry this.',
      locator: { readerType: 'html', location: '1' },
    }],
    putAudioObject: vi.fn(async () => undefined),
    audioObjectExists: vi.fn(async () => false),
    playbackStorage,
    synthesisTimeoutMs: 30_000,
    retryErroredSegments: input.retryErroredSegments,
    ...(input.acquireProviderCapacity ? { acquireProviderCapacity: input.acquireProviderCapacity } : {}),
    onSegmentCompleted,
    onSegmentErrored,
  });
  return { sidecar: () => sidecar, onSegmentCompleted, onSegmentErrored };
}

describe('playback segment retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateTTSBuffer.mockResolvedValue(Buffer.from('mp3'));
  });

  test('keeps an error sidecar as skipped silence unless a retry is requested', async () => {
    const kept = await generate({ sidecar: errorSidecar() });
    expect(mocks.generateTTSBuffer).not.toHaveBeenCalled();
    expect(kept.onSegmentErrored).toHaveBeenCalledOnce();

    const retried = await generate({ sidecar: errorSidecar(), retryErroredSegments: true });
    expect(mocks.generateTTSBuffer).toHaveBeenCalledOnce();
    expect(retried.onSegmentCompleted).toHaveBeenCalledOnce();
    expect(retried.sidecar()?.status).toBe('completed');
  });

  test('waits out saturated provider capacity instead of skipping the segment', async () => {
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn()
      .mockRejectedValueOnce(new ProviderCapacityWaitTimeoutError())
      .mockRejectedValueOnce(new ProviderCapacityWaitTimeoutError())
      .mockRejectedValueOnce(new ProviderCapacityWaitTimeoutError())
      .mockResolvedValue(release);

    const result = await generate({ sidecar: null, acquireProviderCapacity: acquire });

    expect(acquire).toHaveBeenCalledTimes(4);
    expect(mocks.generateTTSBuffer).toHaveBeenCalledOnce();
    expect(result.onSegmentErrored).not.toHaveBeenCalled();
    expect(result.sidecar()?.status).toBe('completed');
  });

  test('retries a transient provider failure after a short backoff', async () => {
    mocks.generateTTSBuffer.mockReset();
    mocks.generateTTSBuffer
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8880'))
      .mockResolvedValue(Buffer.from('mp3'));

    const result = await generate({ sidecar: null });

    expect(mocks.generateTTSBuffer).toHaveBeenCalledTimes(2);
    expect(result.sidecar()?.status).toBe('completed');
  });
});
