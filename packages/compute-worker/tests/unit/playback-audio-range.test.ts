import Fastify from 'fastify';
import { expect, test, vi } from 'vitest';
import { createTtsPlaybackToken } from '@openreader/tts/playback-token';
import { registerPlaybackAudioRoutes } from '../../src/api/routes/playback/audio';
import type { ComputeWorkerRouteContext } from '../../src/api/route-context';
import type { PlaybackSessionReadModel } from '../../src/api/playback/session-read-model';
import type { PlaybackSessionController } from '../../src/api/playback/session-controller';

vi.mock('@openreader/tts/audio-format', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openreader/tts/audio-format')>(),
  getCbrSilenceFrameLengths: async () => [417, 418],
}));

test('answers the WebKit two-byte media probe with a bounded partial response', async () => {
  const app = Fastify();
  const session = {
    sessionId: 'range-session', userId: 'user', storageUserId: 'user', documentId: 'doc',
    status: 'running', expiresAt: Date.now() + 60_000, generationStartOrdinal: 0,
    cursorOrdinal: 0, planObjectKey: 'plan.json', settingsJson: {},
  };
  const readObject = vi.fn(async () => Uint8Array.from([0xff, 0xfb, 0x90, 0x00]).buffer);
  registerPlaybackAudioRoutes({
    app, storage: { readObject }, markActivity: vi.fn(),
  } as unknown as ComputeWorkerRouteContext, {
    readSession: async () => session,
    readPlanSegments: async () => [{ ordinal: 0, text: 'Ready audio.' }],
    readSegmentState: async () => ({ status: 'completed', audioKey: 'audio.mp3' }),
  } as unknown as PlaybackSessionReadModel, {} as PlaybackSessionController);
  try {
    const token = createTtsPlaybackToken({ ...session, exp: session.expiresAt }, process.env.TTS_PLAYBACK_TOKEN_SECRET!);
    const response = await app.inject({
      method: 'GET', url: `/v1/tts-playback/sessions/${session.sessionId}/audio?token=${token}`,
      headers: { range: 'bytes=0-1' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toMatch(/^bytes 0-1\/\d+$/);
    expect(response.headers['content-length']).toBe('2');
    expect(response.rawPayload).toEqual(Buffer.from([0xff, 0xfb]));
    expect(readObject).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test.each([0, 8000])('a direct start at ordinal %i needs no remote duration catalogue', async (fromOrdinal) => {
  const app = Fastify();
  const session = {
    sessionId: 'large-session', userId: 'user', storageUserId: 'user', documentId: 'doc',
    status: 'running', expiresAt: Date.now() + 60_000, generationStartOrdinal: fromOrdinal,
    cursorOrdinal: fromOrdinal, planObjectKey: 'plan.json', settingsJson: {},
  };
  const readSegmentIndexRows = vi.fn(async () => new Promise<never>(() => undefined));
  const readSegmentState = vi.fn(async (_session, ordinal) => ({
    status: 'completed', ordinal, audioKey: `audio/${ordinal}`, durationMs: 1000,
  }));
  const readObject = vi.fn(async () => Uint8Array.from([0xff, 0xfb, 0x90, 0x00]).buffer);
  registerPlaybackAudioRoutes({ app, storage: { readObject }, markActivity: vi.fn() } as never, {
    readSession: async () => session,
    readPlanSegments: async () => Array.from({ length: 10_000 }, (_, ordinal) => ({ ordinal, text: 'A cached sentence.' })),
    readSegmentIndexRows, readSegmentState,
  } as unknown as PlaybackSessionReadModel, { updateCursor: async () => undefined } as never);
  try {
    const token = createTtsPlaybackToken({ ...session, exp: session.expiresAt }, process.env.TTS_PLAYBACK_TOKEN_SECRET!);
    const response = await app.inject({
      method: 'GET', url: `/v1/tts-playback/sessions/${session.sessionId}/audio?token=${token}&fromOrdinal=${fromOrdinal}`,
      headers: { range: 'bytes=0-1' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload).toEqual(Buffer.from([0xff, 0xfb]));
    expect(readSegmentIndexRows).not.toHaveBeenCalled();
    expect(readSegmentState).toHaveBeenCalledExactlyOnceWith(session, fromOrdinal);
  } finally { await app.close(); }
});

test('locates a nonzero byte range using exact prefix durations in bounded reads', async () => {
  const app = Fastify();
  const session = {
    sessionId: 'prefix-session', userId: 'user', storageUserId: 'user', documentId: 'doc',
    status: 'running', expiresAt: Date.now() + 60_000, generationStartOrdinal: 0,
    cursorOrdinal: 0, planObjectKey: 'plan.json', settingsJson: {},
  };
  const readSegmentIndexRows = vi.fn(async (_session, window) => (
    Array.from({ length: window.limit }, (_, offset) => ({ ordinal: window.minOrdinal + offset, durationMs: 1000 }))
  ));
  const readSegmentState = vi.fn(async (_session, ordinal) => ({ status: 'completed', ordinal, audioKey: `audio/${ordinal}` }));
  registerPlaybackAudioRoutes({
    app, storage: { readObject: async (key: string) => Uint8Array.from([Number(key.split('/')[1]), 0xfa, 0xfb]).buffer },
    markActivity: vi.fn(),
  } as never, {
    readSession: async () => session,
    readPlanSegments: async () => Array.from({ length: 2234 }, (_, ordinal) => ({ ordinal, text: 'A long estimated sentence.' })),
    readSegmentIndexRows, readSegmentState,
  } as unknown as PlaybackSessionReadModel, { updateCursor: async () => undefined } as never);
  try {
    const token = createTtsPlaybackToken({ ...session, exp: session.expiresAt }, process.env.TTS_PLAYBACK_TOKEN_SECRET!);
    const response = await app.inject({
      method: 'GET', url: `/v1/tts-playback/sessions/${session.sessionId}/audio?token=${token}`,
      headers: { range: 'bytes=16000-16001' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload).toEqual(Buffer.from([1, 0xfa]));
    expect(readSegmentIndexRows).toHaveBeenCalledExactlyOnceWith(session, { minOrdinal: 0, limit: 32 });
    expect(readSegmentState).toHaveBeenCalledExactlyOnceWith(session, 1);
  } finally { await app.close(); }
});
