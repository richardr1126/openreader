import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  resolveArtifact: vi.fn(),
  createPlayback: vi.fn(),
  createArtifact: vi.fn(),
  createAdmitted: vi.fn(),
  exportProgress: vi.fn(),
  cancelSession: vi.fn(),
  artifactId: vi.fn(),
}));

vi.mock('@openreader/tts/playback-scope', () => ({
  buildTtsPlaybackCanonicalSessionId: vi.fn(() => 'session-1'),
  buildTtsPlaybackExportArtifactId: hoisted.artifactId,
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: vi.fn(() => true),
  ComputeWorkerClient: class ComputeWorkerClient {
    resolveTtsPlaybackSession = hoisted.resolveSession;
    resolveTtsPlaybackExportArtifact = hoisted.resolveArtifact;
    createTtsPlaybackOperation = hoisted.createPlayback;
    createTtsPlaybackExportArtifactOperation = hoisted.createArtifact;
    getTtsPlaybackExportProgress = hoisted.exportProgress;
    cancelTtsPlaybackSession = hoisted.cancelSession;
  },
}));

vi.mock('@/lib/server/admin/settings', () => ({
  getRuntimeConfig: vi.fn(async () => ({ computeLimitPolicies: {} })),
}));

vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: vi.fn(() => ({ logger: {} })),
}));

vi.mock('@/lib/server/tts/playback-request', () => ({
  parseTtsPlaybackRequestBody: vi.fn(() => ({
    documentId: 'doc-1',
    planObjectKey: 'plans/doc-1.json',
  })),
  validateTtsPlaybackSessionStartOrdinal: vi.fn(() => null),
  buildTtsPlaybackPlanningInput: vi.fn(async () => ({
    settingsHash: 'settings-1',
    settingsJson: {},
    planning: { selectedOrdinal: 0 },
  })),
}));

vi.mock('@/lib/server/tts/segments-auth', () => ({
  resolveSegmentDocumentScope: vi.fn(async () => ({
    userId: 'user-1',
    storageUserId: 'user-1',
    documentVersion: 1,
    readerType: 'html',
    isAnonymousUser: false,
  })),
}));

vi.mock('@/lib/server/compute-limits/run-admitted', () => ({
  ComputeAdmissionLimitedError: class ComputeAdmissionLimitedError extends Error {
    code = 'COMPUTE_ADMISSION_RATE_LIMITED';
    retryAfterMs = 1_000;
  },
  createAdmittedComputeOperation: hoisted.createAdmitted,
}));

vi.mock('@/lib/server/rate-limit/request-ip', () => ({
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/server/rate-limit/device-id', () => ({
  getOrCreateDeviceId: vi.fn(() => null),
  setDeviceIdCookie: vi.fn(),
}));

vi.mock('@/lib/server/compute-limits/admission', () => ({
  buildTtsPlaybackAdmissionRequestKey: vi.fn(() => 'playback-request-1'),
}));

function request(body: Record<string, unknown> = { action: 'start' }): NextRequest {
  return new NextRequest('http://localhost/api/tts/export/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'mp3', speed: 1, ...body }),
  });
}

function chapter(index: number, completed: number, skipped = 0, planned = 10) {
  return {
    index,
    title: `Chapter ${index + 1}`,
    spineHref: null,
    page: null,
    plannedSegments: planned,
    completedSegments: completed,
    skippedSegments: skipped,
    generatingSegments: 0,
    durationMs: completed * 1_000,
  };
}

function summary(chapters: ReturnType<typeof chapter>[]) {
  return {
    sessionId: 'session-1',
    status: 'running',
    stopReason: null,
    lastError: null,
    plannedSegments: chapters.reduce((sum, row) => sum + row.plannedSegments, 0),
    completedSegments: chapters.reduce((sum, row) => sum + row.completedSegments, 0),
    skippedSegments: chapters.reduce((sum, row) => sum + row.skippedSegments, 0),
    lastSkipError: null,
    chapters,
  };
}

const noArtifact = { artifact: null, operation: null };
const queuedArtifact = {
  artifact: null,
  operation: { opId: 'artifact-op-1', status: 'queued' },
};
const completeSession = {
  session: { status: 'succeeded' },
  operation: { opId: 'generation-op-1', status: 'succeeded' },
  progress: null,
};

async function post(body?: Record<string, unknown>) {
  const { POST } = await import('../../src/app/api/tts/export/resolve/route');
  const response = await POST(request(body));
  return { status: response.status, json: await response.json() };
}

describe('POST /api/tts/export/resolve', () => {
  beforeEach(() => {
    for (const mock of Object.values(hoisted)) mock.mockReset();
    hoisted.artifactId.mockImplementation((input: { chapterIndex?: number }) => (
      input.chapterIndex === undefined ? 'abcdef1234567890' : `abcdef12345678c${input.chapterIndex}`
    ));
    hoisted.createAdmitted.mockImplementation(
      async (input: { create: () => Promise<unknown> }) => input.create(),
    );
    hoisted.createPlayback.mockResolvedValue({ opId: 'generation-op-2', status: 'queued' });
    hoisted.createArtifact.mockResolvedValue({ opId: 'artifact-op-1', status: 'queued' });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 10)]));
    hoisted.cancelSession.mockResolvedValue({ sessionId: 'session-1', status: 'canceled' });
    hoisted.resolveArtifact
      .mockResolvedValue(noArtifact)
      .mockResolvedValueOnce(noArtifact)
      .mockResolvedValueOnce(queuedArtifact);
  });

  test('uses the durable succeeded session even when its operation status is stale', async () => {
    hoisted.resolveSession.mockResolvedValue({
      ...completeSession,
      operation: { opId: 'generation-op-old', status: 'failed' },
    });

    const { status, json } = await post();

    expect(status).toBe(200);
    expect(json.generation.state).toBe('complete');
    expect(json.artifact).toEqual({ state: 'building', operationId: 'artifact-op-1', issue: null });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
    expect(hoisted.createAdmitted).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tts_playback_export',
      requestKey: 'abcdef1234567890',
    }));
  });

  test('rechecks generation status before creating the artifact in the same request', async () => {
    hoisted.resolveSession
      .mockResolvedValueOnce({ session: null, operation: null, progress: null })
      .mockResolvedValueOnce(completeSession);

    const { status } = await post();

    expect(status).toBe(200);
    expect(hoisted.createPlayback).toHaveBeenCalledOnce();
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
    // Export generation is admitted separately from interactive playback.
    expect(hoisted.createAdmitted.mock.calls.map(([input]) => input.action)).toEqual([
      'tts_playback_document',
      'tts_playback_export',
    ]);
  });

  test('reports a running session whose run ended as interrupted and resumes it', async () => {
    const interrupted = {
      session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'failed', error: { code: 'WORKER_ORPHANED_OP', message: 'stale' } },
      progress: null,
    };
    hoisted.resolveSession.mockResolvedValue(interrupted);
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 4)]));

    const resolved = await post({ action: 'resolve' });
    expect(resolved.json.generation).toEqual({
      state: 'interrupted',
      operationId: 'generation-op-1',
      issue: { code: 'WORKER_ORPHANED_OP', message: 'stale' },
    });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();

    hoisted.resolveSession
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce({ session: { status: 'running' }, operation: { opId: 'generation-op-2', status: 'queued' }, progress: null });
    const resumed = await post({ action: 'start' });
    // The new run waits for a document slot before it starts producing audio.
    expect(resumed.json.generation.state).toBe('queued');
    expect(hoisted.createPlayback).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      generationExtent: 'document',
    }));
    expect(hoisted.createPlayback.mock.calls[0]?.[0]).not.toHaveProperty('retryErroredSegments');
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
  });

  test('keeps a usage-limited run resumable instead of building an incomplete book', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'succeeded', stopReason: 'usage_limit', lastError: 'COMPUTE_USAGE_LIMIT_REACHED' },
      operation: { opId: 'generation-op-1', status: 'succeeded' },
      progress: null,
    });

    const { json } = await post({ action: 'resolve' });

    expect(json.generation.state).toBe('usage_limited');
    expect(json.generation.issue.code).toBe('COMPUTE_USAGE_LIMIT_REACHED');
    expect(json.download).toBeNull();

    await post({ action: 'start' });
    expect(hoisted.createPlayback).toHaveBeenCalledOnce();
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
  });

  test('stops an active run without discarding it', async () => {
    hoisted.resolveSession
      .mockResolvedValueOnce({
        session: { status: 'running', generationRunId: 'run-1' },
        operation: { opId: 'generation-op-1', status: 'running' },
        progress: null,
      })
      .mockResolvedValueOnce({ session: { status: 'canceled' }, operation: { opId: 'generation-op-1', status: 'running' }, progress: null });

    const { json } = await post({ action: 'stop' });

    // The stop is bound to the run it observed.
    expect(hoisted.cancelSession).toHaveBeenCalledWith('session-1', 'run-1');
    expect(json.generation.state).toBe('stopped');
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
  });

  test('retries skipped segments only when some exist', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 8, 2), chapter(1, 10)]));

    await post({ action: 'retry-skipped' });

    expect(hoisted.createPlayback).toHaveBeenCalledWith(expect.objectContaining({ retryErroredSegments: true }));

    hoisted.createPlayback.mockClear();
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 10)]));
    await post({ action: 'retry-skipped' });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
  });

  test('rebuilds a ready artifact whose skipped segments were since generated', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.resolveArtifact.mockReset();
    hoisted.resolveArtifact.mockResolvedValue({
      artifact: { artifactId: 'abcdef1234567890', generatedSegments: 18, skippedSegments: 2 },
      operation: { opId: 'artifact-op-0', status: 'succeeded' },
    });

    const resolved = await post({ action: 'resolve' });
    expect(resolved.json.artifact.state).toBe('stale');
    expect(resolved.json.download).toBeNull();

    await post({ action: 'start' });
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
  });

  test('returns the ready file with its server filename for the download link', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 10)]));
    hoisted.resolveArtifact.mockReset();
    hoisted.resolveArtifact.mockResolvedValue({
      artifact: {
        artifactId: 'abcdef1234567890',
        generatedSegments: 20,
        skippedSegments: 0,
        dispositionFilename: 'openreader-document.mp3',
      },
      operation: null,
    });

    const { json } = await post({ action: 'resolve' });

    expect(json.artifact.state).toBe('ready');
    expect(json.download).toEqual({
      url: '/api/tts/export/download?artifactId=abcdef1234567890&documentId=doc-1',
      filename: 'openreader-document.mp3',
    });
  });

  test('builds a settled chapter while the rest of the book is still generating', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'running' },
      progress: null,
    });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 9, 1), chapter(1, 3)]));

    const { json } = await post({ action: 'start', chapterIndex: 0 });

    expect(json.chapterIndex).toBe(0);
    expect(json.generation.state).toBe('generating');
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
    expect(hoisted.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'abcdef12345678c0',
      chapterIndex: 0,
    }));

    hoisted.createArtifact.mockClear();
    await post({ action: 'start', chapterIndex: 1 });
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
  });

  test('returns the admission retry hint when export work is rate limited', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    const { ComputeAdmissionLimitedError } = await import('@/lib/server/compute-limits/run-admitted');
    hoisted.createAdmitted.mockRejectedValue(new ComputeAdmissionLimitedError(90_000));

    const { status, json } = await post({ action: 'start' });

    expect(status).toBe(429);
    expect(json).toEqual(expect.objectContaining({
      code: 'COMPUTE_ADMISSION_RATE_LIMITED',
      retryAfterMs: 1_000,
    }));
  });
});
