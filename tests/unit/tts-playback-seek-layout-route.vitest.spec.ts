import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET, POST } from '@/app/api/tts/playback/plans/[planId]/seek-layout/route';
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
import { buildTtsPlaybackPlanningInput } from '@/lib/server/tts/playback-request';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';

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

vi.mock('@/lib/server/tts/playback-request', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/tts/playback-request')>(),
  buildTtsPlaybackPlanningInput: vi.fn(),
}));

const listTtsPlaybackScopeCompletedSegments = vi.fn();
vi.mock('@/lib/server/compute-worker/client', () => ({
  getComputeWorkerClient: vi.fn(() => ({ listTtsPlaybackScopeCompletedSegments })),
}));

vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: () => ({ logger: { warn: vi.fn() } }),
  errorToLog: (error: unknown) => error,
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

  test('requires a playback session for the session-owned layout', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/tts/playback/plans/plan-1/seek-layout'),
      { params: Promise.resolve({ planId: 'plan-1' }) },
    );

    expect(response.status).toBe(400);
    expect(resolveTtsPlaybackSession).not.toHaveBeenCalled();
  });

  describe('before Play', () => {
    const payload = {
      documentId: 'document-1',
      settings: {
        providerRef: 'custom-openai',
        providerType: 'custom-openai',
        ttsModel: 'kokoro',
        voice: 'af_heart',
        nativeSpeed: 1,
        language: 'en',
      },
    };
    const post = (body: unknown) => POST(
      new NextRequest('http://localhost/api/tts/playback/plans/plan-1/seek-layout', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ planId: 'plan-1' }) },
    );

    beforeEach(() => {
      vi.mocked(resolveSegmentDocumentScope).mockResolvedValue({
        userId: 'user-1',
        storageUserId: 'storage-1',
        documentVersion: 42,
      } as never);
      vi.mocked(resolveTtsPlaybackPlanOperation).mockResolvedValue({
        status: 'succeeded',
        subject: { kind: 'tts_playback_plan', documentId: 'document-1' },
        result: { planObjectKey: 'plans/document-1/plan.json' },
      } as never);
      vi.mocked(buildTtsPlaybackPlanningInput).mockResolvedValue({
        settingsHash: 'client-settings-hash',
        settingsJson: '{"voice":"af_heart"}',
        planning: {} as never,
      });
      listTtsPlaybackScopeCompletedSegments.mockResolvedValue({
        segments: [{ ordinal: 0, durationMs: 2_400 }],
      });
    });

    test('reads the cache scope the session will use, keyed by the client playback settings', async () => {
      const response = await post(payload);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ planId: 'plan-1', status: null, durationMs: 12_000 });
      expect(listTtsPlaybackScopeCompletedSegments).toHaveBeenCalledWith({
        storageUserId: 'storage-1',
        documentId: 'document-1',
        documentVersion: 42,
        settingsHash: 'client-settings-hash',
        planObjectKey: 'plans/document-1/plan.json',
      });
      expect(buildPlaybackGrid).toHaveBeenCalledWith(expect.objectContaining({
        settingsJson: '{"voice":"af_heart"}',
        completedDurations: new Map([[0, 2_400]]),
      }));
    });

    test('falls back to estimates when the cache cannot be read', async () => {
      listTtsPlaybackScopeCompletedSegments.mockRejectedValue(new Error('worker unavailable'));

      const response = await post(payload);

      expect(response.status).toBe(200);
      expect(buildPlaybackGrid).toHaveBeenCalledWith(expect.objectContaining({ completedDurations: new Map() }));
    });

    test('authenticates before looking up the plan', async () => {
      vi.mocked(resolveSegmentDocumentScope).mockResolvedValue(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) as never,
      );

      expect((await post(payload)).status).toBe(401);
      expect(resolveTtsPlaybackPlanOperation).not.toHaveBeenCalled();
    });

    test('rejects a plan from another document and an invalid request', async () => {
      expect((await post({ ...payload, documentId: 'document-2' })).status).toBe(400);
      expect((await post({ documentId: 'document-1' })).status).toBe(400);
      expect(getComputeWorkerClient).not.toHaveBeenCalled();
    });
  });
});
