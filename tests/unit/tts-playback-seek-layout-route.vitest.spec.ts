import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/tts/playback/plans/[planId]/seek-layout/route';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
  listCompletedTtsPlaybackSegments,
  resolveTtsPlaybackSession,
} from '@/lib/server/tts/playback-sessions';
import {
  buildPlaybackGrid,
  readTtsPlaybackPlanArtifact,
  resolveTtsPlaybackPlanOperation,
} from '@/lib/server/tts/playback-plans';

vi.mock('@/lib/server/tts/segments-auth', () => ({
  resolveSegmentDocumentScope: vi.fn(),
}));

vi.mock('@/lib/server/tts/playback-sessions', () => ({
  listCompletedTtsPlaybackSegments: vi.fn(),
  resolveTtsPlaybackSession: vi.fn(),
}));

vi.mock('@/lib/server/tts/playback-plans', () => ({
  buildPlaybackGrid: vi.fn(),
  readTtsPlaybackPlanArtifact: vi.fn(),
  resolveTtsPlaybackPlanOperation: vi.fn(),
}));

vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: () => ({ logger: {} }),
}));

vi.mock('@/lib/server/errors/next-response', () => ({
  errorResponse: (error: unknown) => {
    throw error;
  },
}));

describe('TTS playback seek-layout route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSegmentDocumentScope).mockResolvedValue({
      userId: 'user-1',
      storageUserId: 'storage-1',
    } as never);
    vi.mocked(readTtsPlaybackPlanArtifact).mockResolvedValue({
      artifact: {
        storageUserId: 'storage-1',
        settingsJson: '{"voice":"af_alloy"}',
      },
      body: '{}',
    } as never);
    vi.mocked(listCompletedTtsPlaybackSegments).mockResolvedValue([]);
    vi.mocked(buildPlaybackGrid).mockReturnValue({
      durationMs: 12_000,
      segments: [],
    });
  });

  test('uses the authenticated session plan artifact when the original plan operation is gone', async () => {
    vi.mocked(resolveTtsPlaybackSession).mockResolvedValue({
      sessionId: 'session-1',
      userId: 'user-1',
      storageUserId: 'storage-1',
      documentId: 'document-1',
      planObjectKey: 'durable/session-plan.json',
      settingsJson: '{"voice":"af_alloy"}',
      generationStartOrdinal: 106,
      status: 'running',
    } as never);

    const response = await GET(
      new NextRequest('http://localhost/api/tts/playback/plans/expired-operation/seek-layout?sessionId=session-1'),
      { params: Promise.resolve({ planId: 'expired-operation' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      planId: 'expired-operation',
      sessionId: 'session-1',
      generationStartOrdinal: 106,
      status: 'running',
      durationMs: 12_000,
    });
    expect(resolveTtsPlaybackPlanOperation).not.toHaveBeenCalled();
    expect(readTtsPlaybackPlanArtifact).toHaveBeenCalledWith('durable/session-plan.json');
    expect(resolveSegmentDocumentScope).toHaveBeenCalledWith(expect.any(NextRequest), 'document-1');
  });
});
