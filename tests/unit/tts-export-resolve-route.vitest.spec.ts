import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  resolveArtifact: vi.fn(),
  createPlayback: vi.fn(),
  createArtifact: vi.fn(),
  createAdmitted: vi.fn(),
}));

vi.mock('@openreader/tts/playback-scope', () => ({
  buildTtsPlaybackCanonicalSessionId: vi.fn(() => 'session-1'),
  buildTtsPlaybackExportArtifactId: vi.fn(() => 'abcdef1234567890'),
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: vi.fn(() => true),
  ComputeWorkerClient: class ComputeWorkerClient {
    resolveTtsPlaybackSession = hoisted.resolveSession;
    resolveTtsPlaybackExportArtifact = hoisted.resolveArtifact;
    createTtsPlaybackOperation = hoisted.createPlayback;
    createTtsPlaybackExportArtifactOperation = hoisted.createArtifact;
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

function request(): NextRequest {
  return new NextRequest('http://localhost/api/tts/export/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: true, format: 'mp3', speed: 1 }),
  });
}

const noArtifact = { artifact: null, operation: null };
const queuedArtifact = {
  artifact: null,
  operation: { opId: 'artifact-op-1', status: 'queued' },
};

describe('POST /api/tts/export/resolve', () => {
  beforeEach(() => {
    hoisted.resolveSession.mockReset();
    hoisted.resolveArtifact.mockReset();
    hoisted.createPlayback.mockReset();
    hoisted.createArtifact.mockReset();
    hoisted.createAdmitted.mockReset();
    hoisted.createAdmitted.mockImplementation(
      async (input: { create: () => Promise<unknown> }) => input.create(),
    );
    hoisted.createPlayback.mockResolvedValue({ opId: 'generation-op-1', status: 'queued' });
    hoisted.createArtifact.mockResolvedValue({ opId: 'artifact-op-1', status: 'queued' });
    hoisted.resolveArtifact
      .mockResolvedValueOnce(noArtifact)
      .mockResolvedValueOnce(queuedArtifact);
  });

  test('uses the durable succeeded session even when its operation status is stale', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'succeeded' },
      operation: { opId: 'generation-op-old', status: 'failed' },
      progress: { completedCount: 35, plannedCount: 35 },
    });
    const { POST } = await import('../../src/app/api/tts/export/resolve/route');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
    expect(hoisted.createAdmitted).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tts_playback_export',
      requestKey: 'abcdef1234567890',
    }));
  });

  test('rechecks generation status before creating the artifact in the same request', async () => {
    hoisted.resolveSession
      .mockResolvedValueOnce({ session: null, operation: null, progress: null })
      .mockResolvedValueOnce({
        session: { status: 'succeeded' },
        operation: { opId: 'generation-op-1', status: 'succeeded' },
        progress: { completedCount: 35, plannedCount: 35 },
      });
    const { POST } = await import('../../src/app/api/tts/export/resolve/route');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(hoisted.createPlayback).toHaveBeenCalledOnce();
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
    expect(hoisted.createAdmitted.mock.calls.map(([input]) => input.action)).toEqual([
      'tts_playback',
      'tts_playback_export',
    ]);
  });
});
