import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TtsPlaybackSegmentMetadata, TtsPlaybackStorage } from '../../src/playback/storage';

const mocks = vi.hoisted(() => ({
  generateTTSBuffer: vi.fn<(
    request?: unknown,
    signal?: AbortSignal,
  ) => Promise<Buffer>>(async () => Buffer.from('test-mp3')),
  runAlignment: vi.fn(),
}));

vi.mock('@openreader/tts/generate', () => ({
  generateTTSBuffer: mocks.generateTTSBuffer,
}));

vi.mock('@openreader/tts/segments', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openreader/tts/segments')>(),
  probeAudioDurationMsFromBuffer: vi.fn(async () => 12_000),
}));

vi.mock('../../src/inference/runtime', () => ({
  runWhisperAlignmentFromAudioBuffer: mocks.runAlignment,
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

describe('playback audio-first segment generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('only reclaims leases from the same session incarnation', async () => {
    const { leaseBelongsToPlaybackSession } = await import('../../src/jobs/playback/segment-generation');
    const owner = JSON.stringify({
      sessionId: 'session-1',
      sessionInstanceId: 'instance-1',
      generationRunId: 'run-1',
    });

    expect(leaseBelongsToPlaybackSession(owner, 'session-1', 'instance-1')).toBe(true);
    expect(leaseBelongsToPlaybackSession(owner, 'session-1', 'instance-2')).toBe(false);
    expect(leaseBelongsToPlaybackSession('session-1:window:run-1', 'session-1', 'instance-1')).toBe(false);
  });

  test('publishes playable audio before alignment and backfills word timing afterward', async () => {
    let resolveAlignment!: (value: {
      alignments: Array<{
        sentence: string;
        sentenceIndex: number;
        words: Array<{
          text: string;
          startSec: number;
          endSec: number;
          charStart: number;
          charEnd: number;
        }>;
      }>;
    }) => void;
    const alignmentPromise = new Promise<Parameters<typeof resolveAlignment>[0]>((resolve) => {
      resolveAlignment = resolve;
    });
    mocks.runAlignment.mockImplementationOnce(() => alignmentPromise);

    let sidecar: TtsPlaybackSegmentMetadata | null = null;
    const writes: TtsPlaybackSegmentMetadata[] = [];
    const onSegmentCompleted = vi.fn(async () => undefined);
    const onSynthesisSettled = vi.fn(async () => undefined);
    const playbackStorage = {
      artifacts: {
        readSegmentMetadata: vi.fn(async () => sidecar),
        putSegmentMetadata: vi.fn(async (metadata: TtsPlaybackSegmentMetadata) => {
          sidecar = metadata;
          writes.push(metadata);
          return 'sidecar-key';
        }),
        getScopeEpoch: vi.fn(async () => 0),
      },
    } as unknown as TtsPlaybackStorage;

    const { generateExplicitTtsPlaybackSegments } = await import('../../src/jobs/playback/segment-generation');
    let finished = false;
    const run = generateExplicitTtsPlaybackSegments({
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
      },
      sessionInstanceId: 'instance-1',
      s3Prefix: 'openreader',
      segments: [{
        ordinal: 0,
        segmentKey: 'segment-0',
        text: 'Audio must be ready first.',
        locator: { readerType: 'html', location: '1' },
      }],
      putAudioObject: vi.fn(async () => undefined),
      audioObjectExists: vi.fn(async () => false),
      playbackStorage,
      synthesisTimeoutMs: 30_000,
      onSynthesisSettled,
      onSegmentCompleted,
    }).finally(() => {
      finished = true;
    });

    await vi.waitFor(() => {
      expect(onSegmentCompleted).toHaveBeenCalledTimes(1);
      expect(sidecar?.status).toBe('completed');
      expect(sidecar?.alignment).toBeNull();
    });
    expect(finished).toBe(false);
    expect(onSynthesisSettled).toHaveBeenCalledTimes(1);

    resolveAlignment({
      alignments: [{
        sentence: 'Audio must be ready first.',
        sentenceIndex: 0,
        words: [{
          text: 'Audio',
          startSec: 0,
          endSec: 0.5,
          charStart: 0,
          charEnd: 5,
        }],
      }],
    });
    await run;

    expect(onSegmentCompleted).toHaveBeenCalledTimes(2);
    expect(writes.at(-1)?.alignment?.words[0]?.text).toBe('Audio');
    expect(writes.at(-1)?.durationMs).toBe(12_000);
  });

  test('starts exact timing while the remaining audio buffer is still synthesizing', async () => {
    type GeneratedAudio = Awaited<ReturnType<typeof mocks.generateTTSBuffer>>;
    let resolveSecondAudio!: (value: GeneratedAudio) => void;
    const secondAudio = new Promise<GeneratedAudio>((resolve) => {
      resolveSecondAudio = resolve;
    });
    mocks.generateTTSBuffer
      .mockResolvedValueOnce(Buffer.from('first-mp3'))
      .mockImplementationOnce(() => secondAudio);
    mocks.runAlignment.mockResolvedValue({
      alignments: [{
        sentence: 'First segment.',
        sentenceIndex: 0,
        words: [{
          text: 'First',
          startSec: 0,
          endSec: 0.5,
          charStart: 0,
          charEnd: 5,
        }],
      }],
    });

    const sidecars = new Map<number, TtsPlaybackSegmentMetadata>();
    const onSegmentCompleted = vi.fn(async () => undefined);
    const playbackStorage = {
      artifacts: {
        readSegmentMetadata: vi.fn(async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null),
        putSegmentMetadata: vi.fn(async (metadata: TtsPlaybackSegmentMetadata) => {
          sidecars.set(metadata.ordinal, metadata);
          return `sidecar-${metadata.ordinal}`;
        }),
        getScopeEpoch: vi.fn(async () => 0),
      },
    } as unknown as TtsPlaybackStorage;

    const { generateExplicitTtsPlaybackSegments } = await import('../../src/jobs/playback/segment-generation');
    const run = generateExplicitTtsPlaybackSegments({
      request: {
        sessionId: 'session-2',
        userId: 'user-1',
        storageUserId: 'user-1',
        documentId: 'document-1',
        documentVersion: 1,
        readerType: 'epub',
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
      },
      sessionInstanceId: 'instance-2',
      s3Prefix: 'openreader',
      segments: [
        {
          ordinal: 0,
          segmentKey: 'segment-0',
          text: 'First segment.',
          locator: { readerType: 'epub', spineHref: 'chapter.xhtml', spineIndex: 0, charOffset: 0 },
        },
        {
          ordinal: 1,
          segmentKey: 'segment-1',
          text: 'Second segment.',
          locator: { readerType: 'epub', spineHref: 'chapter.xhtml', spineIndex: 0, charOffset: 14 },
        },
      ],
      putAudioObject: vi.fn(async () => undefined),
      audioObjectExists: vi.fn(async () => false),
      playbackStorage,
      synthesisTimeoutMs: 30_000,
      onSegmentCompleted,
    });

    await vi.waitFor(() => {
      expect(mocks.generateTTSBuffer).toHaveBeenCalledTimes(2);
      expect(mocks.runAlignment).toHaveBeenCalledTimes(1);
      expect(sidecars.get(0)?.alignment?.words[0]?.text).toBe('First');
    });
    expect(sidecars.get(1)?.status).toBe('generating');
    expect(sidecars.get(1)?.durationMs).toBeNull();
    expect(sidecars.get(1)?.alignment).toBeNull();

    resolveSecondAudio(Buffer.from('second-mp3'));
    await run;

    expect(sidecars.get(1)?.status).toBe('completed');
    expect(onSegmentCompleted).toHaveBeenCalledTimes(4);
  });

  test('aborts an in-flight provider request without persisting an error segment', async () => {
    type GeneratedAudio = Awaited<ReturnType<typeof mocks.generateTTSBuffer>>;
    mocks.generateTTSBuffer.mockImplementationOnce((_request: unknown, signal?: AbortSignal) => (
      new Promise<GeneratedAudio>((_resolve, reject) => {
        void _request;
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      })
    ));
    const sidecars: TtsPlaybackSegmentMetadata[] = [];
    const playbackStorage = {
      artifacts: {
        readSegmentMetadata: vi.fn(async () => sidecars.at(-1) ?? null),
        putSegmentMetadata: vi.fn(async (metadata: TtsPlaybackSegmentMetadata) => {
          sidecars.push(metadata);
          return 'sidecar-0';
        }),
        getScopeEpoch: vi.fn(async () => 0),
      },
    } as unknown as TtsPlaybackStorage;
    const controller = new AbortController();
    const putAudioObject = vi.fn(async () => undefined);

    const { generateExplicitTtsPlaybackSegments } = await import('../../src/jobs/playback/segment-generation');
    const run = generateExplicitTtsPlaybackSegments({
      request: {
        sessionId: 'session-cancel',
        userId: 'user-1',
        storageUserId: 'user-1',
        documentId: 'document-1',
        documentVersion: 1,
        readerType: 'epub',
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
      },
      sessionInstanceId: 'instance-cancel',
      s3Prefix: 'openreader',
      segments: [{
        ordinal: 0,
        segmentKey: 'segment-0',
        text: 'This request should be aborted.',
        locator: { readerType: 'epub', spineHref: 'chapter.xhtml', spineIndex: 0, charOffset: 0 },
      }],
      putAudioObject,
      audioObjectExists: vi.fn(async () => false),
      playbackStorage,
      synthesisTimeoutMs: 30_000,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(mocks.generateTTSBuffer).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(run).resolves.toBeUndefined();

    expect(putAudioObject).not.toHaveBeenCalled();
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0]).toMatchObject({ status: 'generating', error: null });
  });
});
