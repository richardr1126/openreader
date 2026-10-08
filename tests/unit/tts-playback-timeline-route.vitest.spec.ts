import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/tts/stream/[sessionId]/timeline/route';
import { listCompletedTtsPlaybackSegments, resolveTtsPlaybackSession } from '@/lib/server/tts/playback-sessions';
import { readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';

vi.mock('@/lib/server/tts/playback-sessions', () => ({
  listCompletedTtsPlaybackSegments: vi.fn(), resolveTtsPlaybackSession: vi.fn(),
}));
vi.mock('@/lib/server/tts/playback-plans', async (original) => ({
  ...await original<typeof import('@/lib/server/tts/playback-plans')>(),
  readTtsPlaybackPlanArtifact: vi.fn(),
}));
vi.mock('@/lib/server/logger', () => ({ createRequestLogger: () => ({ logger: { info: vi.fn() } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTtsPlaybackSession).mockResolvedValue({
    sessionId: 'session', documentId: 'document', status: 'running', settingsJson: {},
    planObjectKey: 'plan', generationStartOrdinal: 8000, updatedAt: 10,
  } as never);
  vi.mocked(readTtsPlaybackPlanArtifact).mockResolvedValue({
    artifact: { segments: Array.from({ length: 10_000 }, (_, ordinal) => ({ ordinal, text: 'A sentence.', segmentKey: `key-${ordinal}` })) },
  } as never);
  vi.mocked(listCompletedTtsPlaybackSegments).mockResolvedValue([
    { ordinal: 8000, durationMs: 12_000, alignmentJson: null, alignmentSource: null },
  ] as never);
});

test('a deep startup window preserves the canonical plan and bounds worker metadata reads', async () => {
  const response = await GET(new NextRequest('http://localhost/api/tts/stream/session/timeline?minOrdinal=8000&limit=64'), {
    params: Promise.resolve({ sessionId: 'session' }),
  });
  expect(response.status).toBe(200);
  const grid = await response.json();
  expect(listCompletedTtsPlaybackSegments).toHaveBeenCalledWith(expect.anything(), { minOrdinal: 8000, limit: 64 });
  expect(grid.segments).toHaveLength(10_000);
  expect(grid.readWindow).toEqual({ minOrdinal: 8000, limit: 64 });
  expect(grid.segments[8000]).toMatchObject({ generated: true, durationMs: 12_000 });
  expect(grid.generationStartOrdinal).toBe(8000);
});

test('an overview still reads every cached chapter', async () => {
  const response = await GET(new NextRequest('http://localhost/api/tts/stream/session/timeline'), {
    params: Promise.resolve({ sessionId: 'session' }),
  });
  expect(response.status).toBe(200);
  expect(listCompletedTtsPlaybackSegments).toHaveBeenCalledWith(expect.anything(), undefined);
  expect((await response.json()).readWindow).toBeUndefined();
});

test.each(['minOrdinal=-1&limit=64', 'minOrdinal=1&limit=257', 'minOrdinal=1', 'limit=64', 'minOrdinal=&limit=64', 'minOrdinal=%20&limit=64'])('rejects an invalid read window: %s', async (query) => {
  const response = await GET(new NextRequest(`http://localhost/api/tts/stream/session/timeline?${query}`), {
    params: Promise.resolve({ sessionId: 'session' }),
  });
  expect(response.status).toBe(400);
  expect(listCompletedTtsPlaybackSegments).not.toHaveBeenCalled();
});
