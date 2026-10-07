import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ clear: vi.fn(), reclaim: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/server/tts/segments-auth', () => ({
  resolveSegmentDocumentScope: async () => ({ storageUserId: 'user-1', documentVersion: 1, readerType: 'epub' }),
}));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => true,
  ComputeWorkerClient: class {
    clearTtsPlaybackScope = mocks.clear;
    reclaimTtsPlaybackCache = mocks.reclaim;
  },
}));
vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: () => ({ logger: { warn: mocks.warn, error: vi.fn() } }),
}));

import { POST } from '@/app/api/tts/segments/clear/route';

const request = () => new NextRequest('http://localhost/api/tts/segments/clear', {
  method: 'POST', body: JSON.stringify({ documentId: 'doc-1' }),
});

describe('cache clear confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reclaim.mockResolvedValue({ reclaimedVariants: 1, deletedAudioObjects: 2, deletedSidecarObjects: 1,
      deletedExportObjects: 0, invalidatedPlaybackSessions: 0, invalidatedJobOperations: 0 });
  });

  test('waits for cleanup completion before reporting success', async () => {
    let finish!: (value: unknown) => void;
    mocks.clear.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    let settled = false;
    const response = POST(request()).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(mocks.clear).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(mocks.clear.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    finish({ deletedAudioObjects: 2, deletedSidecarObjects: 2, deletedPlanObjects: 1,
      deletedExportObjects: 0, invalidatedPlaybackSessions: 1, invalidatedJobOperations: 2 });
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ deletedPlaybackObjects: 8, invalidatedPlaybackSessions: 1 });
    expect(mocks.reclaim).toHaveBeenCalledWith(expect.objectContaining({
      storageUserId: 'user-1',
      keep: { documentVersion: 1 },
    }), expect.anything());
  });

  test('reports an uncertain timeout instead of falsely confirming or retrying deletion', async () => {
    mocks.clear.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    const result = await POST(request());
    expect(result.status).toBe(504);
    expect((await result.json()).error).toContain('cache may already be reset');
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
