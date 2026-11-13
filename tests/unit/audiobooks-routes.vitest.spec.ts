import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { responseProblems } from './support/openapi-schema';

const hoisted = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  resolveArtifact: vi.fn(),
  createPlayback: vi.fn(),
  createArtifact: vi.fn(),
  createAdmitted: vi.fn(),
  exportProgress: vi.fn(),
  cancelSession: vi.fn(),
  deleteArtifact: vi.fn(),
  artifactId: vi.fn(),
  getOperation: vi.fn(),
  plan: vi.fn(),
  readPlan: vi.fn(),
  storageLimit: vi.fn(),
  findPlan: vi.fn(),
  ensurePdf: vi.fn(),
  settingsHash: vi.fn(),
  readerType: { value: 'html' },
  scopes: { value: ['documents:read', 'documents:write', 'audio:generate'] },
  isAnonymous: { value: false },
  rows: [] as Array<Record<string, unknown>>,
}));

// A small table: filters compare the mocked column names below.
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => [[column, value]],
  and: (...filters: Array<Array<[string, unknown]>>) => filters.flat(),
  lt: (column: string, value: number) => [[column, { below: value }]],
  asc: (column: string) => column,
  desc: (column: string) => column,
}));

vi.mock('@openreader/database/schema', () => ({
  audiobookRequests: { id: 'id', userId: 'userId', documentId: 'documentId', planObjectKey: 'planObjectKey', createdAt: 'createdAt' },
  documentSettings: {},
  documents: {},
  userPreferences: {},
}));

const authUser = { user: { id: 'authUserId', isAnonymous: 'isAnonymous' } };
vi.mock('@openreader/database/schema-auth-sqlite', () => authUser);
vi.mock('@openreader/database/schema-auth-postgres', () => authUser);

vi.mock('@openreader/database', () => {
  const matches = (filters: Array<[string, unknown]>) => (row: Record<string, unknown>) => (
    filters.every(([column, value]) => (
      value && typeof value === 'object' && 'below' in value
        ? Number(row[column]) < Number(value.below)
        : row[column] === value
    ))
  );
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (filters: Array<[string, unknown]>) => {
            const rows = table === authUser.user
              ? [{ isAnonymous: hoisted.isAnonymous.value }]
              : hoisted.rows.filter(matches(filters));
            return Object.assign(Promise.resolve(rows), {
              limit: async () => rows,
              orderBy: () => ({ limit: () => ({ offset: async (skip: number) => rows.slice(skip) }) }),
            });
          },
        }),
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (hoisted.rows.some((existing) => existing.id === row.id)) return [];
              // created_at defaults to now in both schemas.
              hoisted.rows.push({ createdAt: Date.now(), ...row });
              return [{ id: row.id }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: async (filters: Array<[string, unknown]>) => {
            hoisted.rows.filter(matches(filters)).forEach((row) => Object.assign(row, patch));
          },
        }),
      }),
      delete: () => ({
        where: async (filters: Array<[string, unknown]>) => {
          const remove = matches(filters);
          hoisted.rows.splice(0, hoisted.rows.length, ...hoisted.rows.filter((row) => !remove(row)));
        },
      }),
    },
  };
});

vi.mock('@/lib/server/reader/bootstrap', () => ({
  storedRecord: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
  ensurePdfReady: hoisted.ensurePdf,
  detectParsedPdfLanguage: vi.fn(),
}));

vi.mock('@/lib/server/reader/playback', () => ({
  createAdmittedPlaybackPlanOperation: hoisted.plan,
  findPlaybackPlanOperation: hoisted.findPlan,
  resolveDefaultPlaybackRequest: vi.fn(),
}));

vi.mock('@/lib/server/tts/playback-plans', () => ({ readTtsPlaybackPlanArtifact: hoisted.readPlan }));
vi.mock('@/lib/server/storage/usage', () => ({ storageLimit: hoisted.storageLimit }));
vi.mock('@/lib/server/storage/s3', () => ({ getS3Config: () => ({ prefix: 'openreader' }) }));
const planKey = () => `openreader/tts_playback_plan_v1/doc-1/1/${hoisted.readerType.value}/abcdef12.json`;

vi.mock('@/lib/server/api/principal', () => ({
  resolveApiPrincipal: vi.fn(async () => ({
    userId: 'user-1',
    isAnonymous: false,
    scopes: hoisted.scopes.value,
  })),
}));

vi.mock('@openreader/tts/playback-scope', () => ({
  buildTtsPlaybackCanonicalSessionId: vi.fn(() => 'session-1'),
  buildTtsPlaybackExportArtifactId: hoisted.artifactId,
}));

vi.mock('@/lib/server/compute-worker/client', async (importOriginal) => ({
  isComputeWorkerUnavailableError: (
    await importOriginal<typeof import('@/lib/server/compute-worker/client')>()
  ).isComputeWorkerUnavailableError,
  isComputeWorkerAvailable: vi.fn(() => true),
  ComputeWorkerClient: class ComputeWorkerClient {
    resolveTtsPlaybackSession = hoisted.resolveSession;
    resolveTtsPlaybackExportArtifact = hoisted.resolveArtifact;
    createTtsPlaybackOperation = hoisted.createPlayback;
    createTtsPlaybackExportArtifactOperation = hoisted.createArtifact;
    getTtsPlaybackExportProgress = hoisted.exportProgress;
    cancelTtsPlaybackSession = hoisted.cancelSession;
    deleteTtsPlaybackExportArtifact = hoisted.deleteArtifact;
    getOperation = hoisted.getOperation;
  },
}));

vi.mock('@/lib/server/admin/settings', () => ({
  getRuntimeConfig: vi.fn(async () => ({ computeLimitPolicies: {} })),
}));

vi.mock('@/lib/server/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/logger')>(),
  createRequestLogger: vi.fn(() => ({ logger: { warn: vi.fn(), error: vi.fn() } })),
}));

vi.mock('@/lib/server/tts/playback-request', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/tts/playback-request')>(),
  buildTtsPlaybackPlanningInput: vi.fn(async (parsed: unknown) => ({
    settingsHash: hoisted.settingsHash(parsed),
    settingsJson: {},
    planning: { selectedOrdinal: 0 },
  })),
}));

vi.mock('@/lib/server/tts/segments-auth', () => ({
  resolveUserDocumentScope: vi.fn(async () => ({
    userId: 'user-1',
    storageUserId: 'user-1',
    documentVersion: 1,
    readerType: hoisted.readerType.value,
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


vi.mock('@/lib/server/compute-limits/admission', () => ({
  buildTtsPlaybackAdmissionRequestKey: vi.fn(() => 'playback-request-1'),
}));

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

const route = { params: Promise.resolve({ id: 'doc-1' }) };
const baseUrl = 'http://localhost/api/v1/documents/doc-1/audiobooks';

function jsonRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format: 'mp3',
      speed: 1,
      settings: { providerRef: 'provider', providerType: 'openai', ttsModel: 'tts-1', voice: 'alloy', nativeSpeed: 1 },
      planObjectKey: planKey(),
      ...body,
    }),
  });
}

async function start(body: Record<string, unknown> = {}) {
  const { POST } = await import('../../src/app/api/v1/documents/[id]/audiobooks/route');
  const response = await POST(jsonRequest(baseUrl, body), route);
  return { status: response.status, json: await response.json() };
}

async function lookup(body: Record<string, unknown> = {}) {
  const { POST } = await import('../../src/app/api/v1/documents/[id]/audiobooks/lookup/route');
  const response = await POST(jsonRequest(`${baseUrl}/lookup`, body), route);
  return { status: response.status, json: await response.json() };
}

function itemContext(audiobookId: string) {
  return { params: Promise.resolve({ id: 'doc-1', audiobookId }) };
}

async function get(audiobookId: string) {
  const { GET } = await import('../../src/app/api/v1/documents/[id]/audiobooks/[audiobookId]/route');
  const response = await GET(new NextRequest(`${baseUrl}/${audiobookId}`), itemContext(audiobookId));
  return { status: response.status, json: await response.json() };
}

async function stop(audiobookId: string) {
  const { POST } = await import('../../src/app/api/v1/documents/[id]/audiobooks/[audiobookId]/cancel/route');
  const response = await POST(new NextRequest(`${baseUrl}/${audiobookId}/cancel`, { method: 'POST' }), itemContext(audiobookId));
  return { status: response.status, json: await response.json() };
}

async function remove(audiobookId: string) {
  const { DELETE } = await import('../../src/app/api/v1/documents/[id]/audiobooks/[audiobookId]/route');
  const response = await DELETE(new NextRequest(`${baseUrl}/${audiobookId}`, { method: 'DELETE' }), itemContext(audiobookId));
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function list(query = '') {
  const { GET } = await import('../../src/app/api/v1/documents/[id]/audiobooks/route');
  const response = await GET(new NextRequest(`${baseUrl}${query}`), route);
  return { status: response.status, json: await response.json() };
}

describe('/api/v1/documents/[id]/audiobooks', () => {
  beforeEach(() => {
    for (const mock of [
      hoisted.resolveSession, hoisted.resolveArtifact, hoisted.createPlayback, hoisted.createArtifact,
      hoisted.createAdmitted, hoisted.exportProgress, hoisted.cancelSession, hoisted.deleteArtifact, hoisted.artifactId,
      hoisted.getOperation, hoisted.plan,
      hoisted.readPlan, hoisted.findPlan, hoisted.ensurePdf, hoisted.settingsHash, hoisted.storageLimit,
    ]) mock.mockReset();
    hoisted.storageLimit.mockResolvedValue(null);
    // Vite sets BASE_URL to its own base path under test.
    vi.stubEnv('BASE_URL', 'http://localhost:3003');
    hoisted.rows.length = 0;
    hoisted.isAnonymous.value = false;
    hoisted.readerType.value = 'html';
    hoisted.scopes.value = ['documents:read', 'documents:write', 'audio:generate'];
    hoisted.settingsHash.mockReturnValue('settings-1');
    hoisted.findPlan.mockResolvedValue(null);
    hoisted.readPlan.mockResolvedValue({ artifact: {
      storageUserId: 'user-1', documentId: 'doc-1', documentVersion: 1, readerType: 'html',
    } });
    hoisted.getOperation.mockResolvedValue(null);
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

    const { status, json } = await start();

    expect(status).toBe(202);
    expect(json.generation.state).toBe('complete');
    expect(json.artifact).toEqual({ state: 'building', operationId: 'artifact-op-1', issue: null });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
    expect(hoisted.createAdmitted).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tts_playback_export',
      requestKey: 'abcdef1234567890',
    }));
  });

  test('reports a book whose session expired as complete from its cache scope', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: null, operation: null, progress: null });
    hoisted.resolveArtifact.mockReset().mockResolvedValue({
      artifact: { dispositionFilename: 'book.mp3', generatedSegments: 20, skippedSegments: 0 }, operation: null,
    });

    const found = await lookup({ includeProgress: false });
    expect(found.json.generation.state).toBe('complete');
    expect(found.json.segments.chapters).toHaveLength(2);
    expect(found.json.filename).toBe('book.mp3');
    expect(hoisted.exportProgress).toHaveBeenCalledWith({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 1,
      settingsHash: 'settings-1',
      planObjectKey: planKey(),
    });

    await start();
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
  });

  test('offers generation for an idle scope with segments still missing', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: null, operation: null, progress: null });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 4)]));
    const { json } = await lookup({ includeProgress: false });
    expect(json.generation.state).toBe('idle');
    expect(json.segments.completedSegments).toBe(14);
  });

  test('finds a ready file without entering a slow chapter scan', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockImplementation(() => new Promise(() => undefined));
    hoisted.resolveArtifact.mockReset().mockResolvedValue({
      artifact: { dispositionFilename: 'book.mp3', generatedSegments: 2234, skippedSegments: 0 }, operation: null,
    });
    const { status, json } = await lookup({ includeProgress: false });
    expect(status).toBe(200);
    expect(json.filename).toBe('book.mp3');
    expect(json.segments).toBeNull();
    expect(hoisted.exportProgress).not.toHaveBeenCalled();
  });

  test('acknowledges Stop without waiting for chapter storage', async () => {
    const running = {
      session: { status: 'running', generationRunId: 'observed-run' },
      operation: { opId: 'generation-op', status: 'running' },
    };
    hoisted.resolveSession.mockResolvedValue(running);
    const { json: started } = await start({ includeProgress: false });
    hoisted.resolveSession.mockReset();
    hoisted.resolveSession.mockResolvedValueOnce(running)
      .mockResolvedValue({ session: { status: 'canceled' }, operation: null });
    hoisted.exportProgress.mockImplementation(() => new Promise(() => undefined));
    const { json } = await stop(started.id);
    expect(hoisted.cancelSession).toHaveBeenCalledWith('session-1', 'observed-run');
    expect(json).toMatchObject({ status: 'cancelled', generation: { state: 'stopped' } });
    expect(hoisted.exportProgress).not.toHaveBeenCalled();
    expect(hoisted.rows).toEqual([expect.objectContaining({ id: started.id, cancelledAt: expect.any(Number) })]);
  });

  test('detects a stale file using durable operation counts during fast discovery', async () => {
    hoisted.resolveSession.mockResolvedValue({ ...completeSession,
      progress: { completedCount: 2234, plannedCount: 2234, skippedCount: 0 },
    });
    hoisted.resolveArtifact.mockReset().mockResolvedValue({
      artifact: { generatedSegments: 2233, skippedSegments: 1 }, operation: null,
    });
    const { json } = await lookup({ includeProgress: false });
    expect(json.artifact.state).toBe('stale');
    expect(json.downloadUrl).toBeNull();
    expect(json.webDownloadUrl).toBeNull();
  });

  test('a full account gets a storage issue instead of a new file', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 0), chapter(1, 0)]));
    hoisted.storageLimit.mockResolvedValue({ code: 'ACCOUNT_STORAGE_LIMIT_REACHED', message: 'Storage is full.' });

    const { json } = await start();

    expect(hoisted.createArtifact).not.toHaveBeenCalled();
    expect(json.artifact).toMatchObject({ state: 'failed', issue: { code: 'ACCOUNT_STORAGE_LIMIT_REACHED' } });
  });

  test('rechecks generation status before creating the artifact in the same request', async () => {
    hoisted.resolveSession
      .mockResolvedValueOnce({ session: null, operation: null, progress: null })
      .mockResolvedValueOnce(completeSession);
    hoisted.exportProgress.mockResolvedValueOnce(summary([chapter(0, 0), chapter(1, 0)]));

    const { status } = await start();

    expect(status).toBe(202);
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

    const resolved = await lookup();
    expect(resolved.json.generation).toEqual({
      state: 'interrupted',
      operationId: 'generation-op-1',
      issue: { code: 'WORKER_ORPHANED_OP', message: 'stale' },
    });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();

    hoisted.resolveSession
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce({ session: { status: 'running' }, operation: { opId: 'generation-op-2', status: 'queued' }, progress: null });
    const resumed = await start();
    // The new run waits for a document slot before it starts producing audio.
    expect(resumed.json.generation.state).toBe('queued');
    expect(hoisted.createPlayback).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      generationExtent: 'document',
    }));
    expect(hoisted.createPlayback.mock.calls[0]?.[0]).not.toHaveProperty('retryErroredSegments');
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
  });

  test('gives concurrent starts of the same stopped export one run, and a later resume a new one', async () => {
    const stopped = {
      session: { status: 'canceled', generationRunId: 'run-1', updatedAt: 100 },
      operation: { opId: 'generation-op-1', status: 'succeeded' },
      progress: null,
    };
    hoisted.resolveSession.mockResolvedValue(stopped);

    await Promise.all([start(), start()]);
    const [first, second] = hoisted.createPlayback.mock.calls.map(([input]) => input.generationRunId);
    expect(first).toBe(second);

    hoisted.resolveSession.mockResolvedValue({
      ...stopped,
      session: { status: 'canceled', generationRunId: first, updatedAt: 200 },
    });
    await start();
    expect(hoisted.createPlayback.mock.calls[2]?.[0].generationRunId).not.toBe(first);
  });

  test('keeps a usage-limited run resumable instead of building an incomplete book', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'succeeded', stopReason: 'usage_limit', lastError: 'COMPUTE_USAGE_LIMIT_REACHED' },
      operation: { opId: 'generation-op-1', status: 'succeeded' },
      progress: null,
    });

    const { json } = await lookup();

    expect(json.generation.state).toBe('usage_limited');
    expect(json.generation.issue.code).toBe('COMPUTE_USAGE_LIMIT_REACHED');
    expect(json.downloadUrl).toBeNull();

    await start();
    expect(hoisted.createPlayback).toHaveBeenCalledOnce();
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
  });

  test('a stopped audiobook stays stopped until it is asked for again', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'running', generationRunId: 'run-1' },
      operation: { opId: 'generation-op-1', status: 'running' },
      progress: null,
    });
    const { json: started } = await start();
    hoisted.resolveSession.mockResolvedValue({ session: { status: 'canceled' }, operation: null, progress: null });

    expect((await get(started.id)).json.generation.state).toBe('stopped');
    expect(hoisted.createPlayback).not.toHaveBeenCalled();

    await stop(started.id);
    const cancelled = await get(started.id);
    expect(cancelled).toMatchObject({ status: 200, json: { status: 'cancelled' } });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();

    // Asking again resumes it.
    await start();
    expect(hoisted.rows[0].cancelledAt).toBeNull();
    expect(hoisted.createPlayback).toHaveBeenCalledOnce();
  });

  test('session expiry does not turn a failed run into a new synthesis request', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'running' } });
    const { json } = await start();
    hoisted.resolveSession.mockResolvedValue({ session: null, operation: null, progress: null });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 3)]));
    hoisted.getOperation.mockResolvedValue({ opId: 'generation-op-1', status: 'failed', error: { message: 'provider failed' } });
    const found = await get(json.id);
    expect(found.json.generation.state).toBe('failed');
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
  });

  test('retries skipped segments only when some exist', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 8, 2), chapter(1, 10)]));

    await start({ retrySkipped: true });

    expect(hoisted.createPlayback).toHaveBeenCalledWith(expect.objectContaining({ retryErroredSegments: true }));

    hoisted.createPlayback.mockClear();
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 10)]));
    await start({ retrySkipped: true });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
  });

  test('rebuilds a ready artifact whose skipped segments were since generated', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.resolveArtifact.mockReset();
    hoisted.resolveArtifact.mockResolvedValue({
      artifact: { artifactId: 'abcdef1234567890', generatedSegments: 18, skippedSegments: 2 },
      operation: { opId: 'artifact-op-0', status: 'succeeded' },
    });

    const resolved = await lookup();
    expect(resolved.json.artifact.state).toBe('stale');
    expect(resolved.json.downloadUrl).toBeNull();

    await start();
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
  });

  test('a failed stale-artifact rebuild waits for an explicit retry instead of looping on signals', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    await start();
    hoisted.createArtifact.mockClear();
    hoisted.resolveArtifact.mockReset().mockResolvedValue({
      artifact: { generatedSegments: 18, skippedSegments: 2 },
      operation: { opId: 'failed-build', status: 'failed', error: { message: 'compile failed' } },
    });
    hoisted.getOperation.mockResolvedValue({ subject: { kind: 'tts_playback_export', documentId: 'doc-1' } });
    const { advanceAudiobooksAfterOperation } = await import('@/lib/server/audiobooks/audiobooks');
    await advanceAudiobooksAfterOperation('failed-build', 'user-1');
    expect((await lookup()).json.artifact.state).toBe('failed');
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
    await start();
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

    const { json } = await lookup();

    expect(json.artifact.state).toBe('ready');
    expect(json.downloadUrl).toBe('/api/v1/documents/doc-1/audiobooks/files/abcdef1234567890');
    expect(new URL(json.webDownloadUrl).pathname).toBe('/audiobooks/doc-1/abcdef1234567890');
    expect(json.filename).toBe('openreader-document.mp3');
  });

  test('builds a settled chapter while the rest of the book is still generating', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'running' },
      progress: null,
    });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 9, 1), chapter(1, 3)]));

    const { json } = await start({ chapter: 0 });

    expect(json.chapter).toBe(0);
    expect(json.generation.state).toBe('generating');
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
    expect(hoisted.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'abcdef12345678c0',
      chapterIndex: 0,
    }));

    hoisted.createArtifact.mockClear();
    const pending = await start({ chapter: 1 });
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
    // The id of a chapter that is still generating can be read until its file is due.
    expect((await get(pending.json.id)).status).toBe(200);
  });

  test('stopping a chapter cannot cancel the shared whole-book run', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: { status: 'running', generationRunId: 'book-run' },
      operation: { opId: 'generation-op-1', status: 'running' } });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 3)]));
    const { json } = await start({ chapter: 0 });
    expect((await stop(json.id)).status).toBe(400);
    expect(hoisted.cancelSession).not.toHaveBeenCalled();
  });

  test('rejects chapter indices that are not non-negative integers', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    for (const chapter of ['', false, '0', -1, 1.5]) {
      const { status } = await lookup({ chapter });
      expect(status).toBe(400);
    }
    expect(hoisted.resolveArtifact).not.toHaveBeenCalled();
  });

  test('uses the real settings parser and never persists credential fields', async () => {
    const rejected = await start({ settings: {} });
    expect(rejected.status).toBe(400);
    hoisted.resolveSession.mockResolvedValue(completeSession);
    await start({ settings: { providerRef: 'provider', providerType: 'openai', ttsModel: 'tts-1',
      voice: 'alloy', nativeSpeed: 1, apiKey: 'must-not-persist', baseUrl: 'must-not-persist' } });
    expect(JSON.stringify(hoisted.rows)).not.toContain('must-not-persist');
  });

  test('rejects a plan for another owner before starting work', async () => {
    hoisted.readPlan.mockResolvedValue({ artifact: {
      storageUserId: 'other-user', documentId: 'doc-1', documentVersion: 1, readerType: 'html',
    } });
    expect((await start()).status).toBe(403);
    expect(hoisted.createAdmitted).not.toHaveBeenCalled();
    expect(hoisted.rows).toHaveLength(0);
  });

  test('refuses a plan key outside this document before reading it', async () => {
    for (const planObjectKey of ['openreader/documents_v1/doc-1', 'openreader/tts_playback_plan_v1/doc-2/1/html/abcdef12.json',
      'openreader/tts_playback_plan_v1/doc-1/1/html/../../doc-2/1/html/abcdef12.json']) {
      expect((await start({ planObjectKey })).status).toBe(403);
    }
    expect(hoisted.readPlan).not.toHaveBeenCalled();
    expect(hoisted.rows).toHaveLength(0);
  });

  test('serializes a signal and GET so they build and admit the file only once', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'running' } });
    const { json } = await start();
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.resolveArtifact.mockReset().mockResolvedValue(noArtifact);
    hoisted.getOperation.mockResolvedValue({ subject: { kind: 'tts_playback', documentId: 'doc-1' } });
    hoisted.createArtifact.mockImplementation(async () => {
      hoisted.resolveArtifact.mockResolvedValue(queuedArtifact);
      return queuedArtifact.operation;
    });
    hoisted.createAdmitted.mockClear();
    const { advanceAudiobooksAfterOperation } = await import('@/lib/server/audiobooks/audiobooks');
    await Promise.all([get(json.id), advanceAudiobooksAfterOperation('generation-op-1', 'user-1')]);
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
    expect(hoisted.createAdmitted).toHaveBeenCalledOnce();
  });

  test('a GET waiting behind Stop observes the cancelled request and cannot start work', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: { status: 'running', generationRunId: 'run-1' },
      operation: { opId: 'generation-op-1', status: 'running' } });
    const { json } = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const cancelling = new Promise<void>((resolve) => { entered = resolve; });
    hoisted.cancelSession.mockImplementation(async () => {
      entered();
      await gate;
      hoisted.resolveSession.mockResolvedValue({ session: { status: 'canceled' }, operation: null });
    });
    const stopping = stop(json.id);
    await cancelling;
    const reading = get(json.id);
    release();
    await stopping;
    expect(await reading).toMatchObject({ status: 200, json: { status: 'cancelled' } });
    expect(hoisted.createPlayback).not.toHaveBeenCalled();
  });

  test('rejects a chapter it cannot find, even for a complete book without progress', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockResolvedValue(null);

    const { status } = await start({ chapter: 7 });

    expect(status).toBe(404);
    expect(hoisted.createAdmitted).not.toHaveBeenCalled();
    expect(hoisted.createArtifact).not.toHaveBeenCalled();
  });

  test('a limit at compile keeps the request, reports waiting and retries on the next read', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.resolveArtifact.mockReset().mockResolvedValue(noArtifact);
    const { ComputeAdmissionLimitedError } = await import('@/lib/server/compute-limits/run-admitted');
    hoisted.createAdmitted.mockRejectedValueOnce(new ComputeAdmissionLimitedError(90_000));

    const { status, json } = await start();

    expect(status).toBe(202);
    expect(json.status).toBe('waiting');
    expect(json.artifact.state).toBe('waiting');
    expect(json.retryAfterMs).toBe(1_000);
    expect(hoisted.rows).toHaveLength(1);

    await get(json.id);
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
  });

  test('a limit before any audio refuses the request and remembers nothing', async () => {
    hoisted.resolveSession.mockResolvedValue({ session: null, operation: null, progress: null });
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 0), chapter(1, 0)]));
    const { ComputeAdmissionLimitedError } = await import('@/lib/server/compute-limits/run-admitted');
    hoisted.createAdmitted.mockRejectedValue(new ComputeAdmissionLimitedError(90_000));

    const { status, json } = await start();

    expect(status).toBe(429);
    expect(json.error).toEqual(expect.objectContaining({
      code: 'COMPUTE_ADMISSION_RATE_LIMITED',
      retryAfterMs: 1_000,
    }));
    expect(hoisted.rows).toHaveLength(0);
  });

  test('a failed read after enqueueing preserves the intent for closed-tab completion', async () => {
    hoisted.resolveSession.mockReset()
      .mockResolvedValueOnce({ session: null, operation: null, progress: null })
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 0)]));
    expect((await start()).status).toBe(503);
    expect(hoisted.createPlayback).toHaveBeenCalledOnce();
    expect(hoisted.rows).toHaveLength(1);
    hoisted.resolveSession.mockResolvedValue(completeSession);
    hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10)]));
    await get(String(hoisted.rows[0].id));
    expect(hoisted.createArtifact).toHaveBeenCalledOnce();
  });

  test('a repeated request returns the same audiobook, and another format gets its own', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    const first = await start();
    const second = await start();
    const m4b = await start({ format: 'm4b' });

    expect(second.json.id).toBe(first.json.id);
    expect(m4b.json.id).not.toBe(first.json.id);
    expect(hoisted.rows).toHaveLength(2);
  });

  test('looking up settings nobody asked for never starts work', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    const { json } = await lookup();

    expect(json.artifact.state).toBe('none');
    expect(hoisted.createAdmitted).not.toHaveBeenCalled();
    expect(hoisted.rows).toHaveLength(0);
    expect((await get(json.id)).status).toBe(404);
  });

  test('adopts a run that predates its request so it can be stopped', async () => {
    hoisted.resolveSession.mockResolvedValue({
      session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'running' },
      progress: null,
    });
    await lookup();
    expect(hoisted.rows).toHaveLength(1);
  });

  describe('worker completion signal', () => {
    async function requested() {
      hoisted.getOperation.mockResolvedValue({ opId: 'op-1', subject: { kind: 'tts_playback', documentId: 'doc-1' } });
      hoisted.resolveSession.mockResolvedValueOnce({
        session: { status: 'running' },
        operation: { opId: 'generation-op-1', status: 'running' },
        progress: null,
      });
      await start();
      hoisted.createArtifact.mockClear();
      hoisted.resolveSession.mockResolvedValue(completeSession);
      hoisted.resolveArtifact.mockReset().mockResolvedValue(noArtifact);
    }

    test('compiles the file with no client when generation finishes', async () => {
      await requested();
      const { advanceAudiobooksAfterOperation } = await import('@/lib/server/audiobooks/audiobooks');

      await advanceAudiobooksAfterOperation('generation-op-1', 'user-1');

      expect(hoisted.createArtifact).toHaveBeenCalledOnce();
      expect(hoisted.createAdmitted).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'tts_playback_export',
        subject: { userId: 'user-1', isAnonymous: false },
      }));
    });

    test('leaves a guest export for their next request, which compiles it', async () => {
      await requested();
      hoisted.isAnonymous.value = true;
      const { advanceAudiobooksAfterOperation } = await import('@/lib/server/audiobooks/audiobooks');

      await advanceAudiobooksAfterOperation('generation-op-1', 'user-1');
      expect(hoisted.createArtifact).not.toHaveBeenCalled();

      await lookup();
      expect(hoisted.createArtifact).toHaveBeenCalledOnce();
    });

    test('does not resume a failed run', async () => {
      await requested();
      hoisted.resolveSession.mockResolvedValue({
        session: { status: 'failed', lastError: 'boom' },
        operation: { opId: 'generation-op-1', status: 'failed' },
        progress: null,
      });
      hoisted.createPlayback.mockClear();
      const { advanceAudiobooksAfterOperation } = await import('@/lib/server/audiobooks/audiobooks');

      await advanceAudiobooksAfterOperation('generation-op-1', 'user-1');

      expect(hoisted.createPlayback).not.toHaveBeenCalled();
      expect(hoisted.createArtifact).not.toHaveBeenCalled();
    });

    test('runs the plan step first when no plan was supplied, then generation on its signal', async () => {
      hoisted.plan.mockResolvedValueOnce({ opId: 'plan-op', status: 'running' });
      hoisted.resolveSession.mockResolvedValue({ session: null, operation: null, progress: null });
      hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 0), chapter(1, 0)]));
      const { json } = await start({ planObjectKey: undefined });
      expect(json.status).toBe('preparing');
      expect(hoisted.createPlayback).not.toHaveBeenCalled();

      hoisted.plan.mockResolvedValueOnce({
        opId: 'plan-op',
        status: 'succeeded',
        result: { planObjectKey: planKey() },
      });
      const { advanceAudiobooksAfterOperation } = await import('@/lib/server/audiobooks/audiobooks');
      hoisted.getOperation.mockResolvedValue({ opId: 'plan-op', subject: { kind: 'tts_playback_plan', documentId: 'doc-1' } });
      await advanceAudiobooksAfterOperation('plan-op', 'user-1');

      expect(hoisted.createPlayback).toHaveBeenCalledOnce();
      expect(hoisted.rows[0]?.planObjectKey).toBe(planKey());
    });
  });

  test('reports an unreachable (for example redeploying) worker as retryable', async () => {
    hoisted.resolveSession.mockRejectedValue(new TypeError('fetch failed'));

    const { status, json } = await lookup();

    expect(status).toBe(503);
    expect(json.error).toEqual(expect.objectContaining({
      code: 'COMPUTE_WORKER_UNAVAILABLE',
      message: expect.stringContaining('compute worker is unavailable'),
    }));
  });

  describe('read-only callers', () => {
    const readOnly = () => { hoisted.scopes.value = ['documents:read']; };
    const running = {
      session: { status: 'running' },
      operation: { opId: 'generation-op-1', status: 'running' },
      progress: null,
    };

    test('reading a request does not build its file', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      const { json } = await start();
      hoisted.createAdmitted.mockClear();
      hoisted.resolveSession.mockResolvedValue(completeSession);
      hoisted.resolveArtifact.mockReset().mockResolvedValue(noArtifact);
      readOnly();

      expect((await get(json.id)).status).toBe(200);
      expect((await lookup()).status).toBe(200);
      expect(hoisted.createAdmitted).not.toHaveBeenCalled();
      expect(hoisted.createArtifact).not.toHaveBeenCalled();
    });

    test('reading a request does not resume stopped generation', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      const { json } = await start();
      hoisted.createAdmitted.mockClear();
      hoisted.createPlayback.mockClear();
      hoisted.resolveSession.mockResolvedValue({ session: null, operation: null, progress: null });
      hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 3), chapter(1, 0)]));
      readOnly();

      await get(json.id);
      expect(hoisted.createAdmitted).not.toHaveBeenCalled();
      expect(hoisted.createPlayback).not.toHaveBeenCalled();
    });

    test('looking up a run does not adopt it', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      readOnly();
      await lookup();
      expect(hoisted.rows).toHaveLength(0);
    });

    test('without a plan key it finds the plan but never creates or stores one', async () => {
      hoisted.plan.mockResolvedValue({ opId: 'plan-op', status: 'queued' });
      const { json } = await start({ planObjectKey: undefined });
      hoisted.plan.mockClear();
      readOnly();

      expect((await get(json.id)).json.generation.state).toBe('idle');
      hoisted.findPlan.mockResolvedValue({ opId: 'plan-op', status: 'succeeded', result: { kind: 'tts_playback_plan', planObjectKey: 'plans/found.json' } });
      hoisted.resolveSession.mockResolvedValue(running);
      expect((await get(json.id)).status).toBe(200);
      expect(hoisted.plan).not.toHaveBeenCalled();
      expect(hoisted.rows[0].planObjectKey ?? null).toBeNull();
    });
  });

  describe('request validation', () => {
    test.each([
      [{ format: 'ogg' }],
      [{ format: 7 }],
      [{ speed: 3.5 }],
      [{ speed: 0.1 }],
      [{ speed: '1' }],
    ])('rejects %j rather than quietly choosing something else', async (body) => {
      expect((await start(body)).status).toBe(400);
      expect(hoisted.rows).toHaveLength(0);
    });

    test('near-equal speeds are one request', async () => {
      hoisted.resolveSession.mockResolvedValue(completeSession);
      const first = await start({ speed: 1.2 });
      const second = await start({ speed: 1.2000001 });
      expect(second.json.id).toBe(first.json.id);
      expect(hoisted.rows).toHaveLength(1);
    });
  });

  describe('a PDF that has not been parsed', () => {
    const savedSettings = { settings: undefined, planObjectKey: undefined };
    const notStarted = { result: { status: 'error', message: 'PDF preparation has not started.', retryable: true } };
    beforeEach(() => { hoisted.readerType.value = 'pdf'; });

    test('a lookup only observes the parse and reports it is not ready', async () => {
      hoisted.ensurePdf.mockResolvedValue(notStarted);
      const { status, json } = await lookup(savedSettings);

      expect(status).toBe(409);
      expect(json.error.code).toBe('DOCUMENT_PREPARING');
      expect(hoisted.ensurePdf).toHaveBeenCalledWith('doc-1', expect.anything(), expect.objectContaining({ observeOnly: true }));
    });

    test('a start begins the parse, and a limit on it reaches the caller with its retry time', async () => {
      const { ComputeAdmissionLimitedError } = await import('@/lib/server/compute-limits/run-admitted');
      hoisted.ensurePdf.mockRejectedValue(new ComputeAdmissionLimitedError(90_000));
      const { POST } = await import('../../src/app/api/v1/documents/[id]/audiobooks/route');
      const response = await POST(jsonRequest(baseUrl, savedSettings), route);

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('1');
      expect((await response.json()).error.retryAfterMs).toBe(1_000);
      expect(hoisted.ensurePdf).toHaveBeenCalledWith('doc-1', expect.anything(), expect.objectContaining({ throwAdmissionLimit: true }));
      expect(hoisted.ensurePdf.mock.calls[0][2].observeOnly).toBeFalsy();
    });
  });

  describe('Stop with several requests', () => {
    const running = {
      session: { status: 'running', generationRunId: 'observed-run' },
      operation: { opId: 'generation-op', status: 'running' },
    };
    const otherVoice = { settings: { providerRef: 'provider', providerType: 'openai', ttsModel: 'tts-1', voice: 'nova', nativeSpeed: 1 } };
    beforeEach(() => {
      hoisted.settingsHash.mockImplementation((parsed: unknown) => (
        JSON.stringify(parsed).includes('nova') ? 'settings-2' : 'settings-1'
      ));
    });

    test('cancelling a run cancels the formats sharing it and leaves other settings', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      const mp3 = (await start({ includeProgress: false })).json;
      const m4b = (await start({ includeProgress: false, format: 'm4b' })).json;
      const other = (await start({ includeProgress: false, ...otherVoice })).json;
      expect(hoisted.rows).toHaveLength(3);
      hoisted.resolveSession.mockReset();
      hoisted.resolveSession.mockResolvedValueOnce(running)
        .mockResolvedValue({ session: { status: 'canceled' }, operation: null });

      expect((await stop(mp3.id)).json.generation.state).toBe('stopped');

      expect(hoisted.cancelSession).toHaveBeenCalledOnce();
      expect((await get(m4b.id)).json.status).toBe('cancelled');
      expect(hoisted.rows.filter((row) => !row.cancelledAt).map((row) => row.id)).toEqual([other.id]);
    });

    test('stopping an already-stopped format leaves a resumed sibling running', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      const mp3 = (await start({ includeProgress: false })).json;
      const m4b = (await start({ includeProgress: false, format: 'm4b' })).json;
      await stop(mp3.id);
      expect(hoisted.cancelSession).toHaveBeenCalledOnce();

      await start({ includeProgress: false, format: 'm4b' });
      const repeated = await stop(mp3.id);

      expect(repeated.json.status).toBe('cancelled');
      expect(hoisted.cancelSession).toHaveBeenCalledOnce();
      expect(hoisted.rows.find((row) => row.id === m4b.id)?.cancelledAt).toBeNull();
    });

    test('with nothing to cancel, only the named request is cancelled', async () => {
      hoisted.resolveSession.mockResolvedValue(completeSession);
      const mp3 = (await start()).json;
      const m4b = (await start({ format: 'm4b' })).json;

      await stop(mp3.id);

      expect(hoisted.cancelSession).not.toHaveBeenCalled();
      expect(hoisted.rows.filter((row) => !row.cancelledAt).map((row) => row.id)).toEqual([m4b.id]);
    });

    test('a chapter request keeps going when the whole-book run is stopped', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      const mp3 = (await start({ includeProgress: false })).json;
      hoisted.rows.push({ ...hoisted.rows[0], id: 'chapter-row', chapterIndex: 0 });
      hoisted.resolveSession.mockReset();
      hoisted.resolveSession.mockResolvedValueOnce(running)
        .mockResolvedValue({ session: { status: 'canceled' }, operation: null });

      await stop(mp3.id);
      expect(hoisted.rows.filter((row) => !row.cancelledAt).map((row) => row.id)).toEqual(['chapter-row']);
    });
  });

  describe('deleting and listing', () => {
    const running = {
      session: { status: 'running', generationRunId: 'observed-run' },
      operation: { opId: 'generation-op', status: 'running' },
    };
    const readyArtifact = {
      artifact: { artifactId: 'abcdef1234567890', generatedSegments: 20, skippedSegments: 0, dispositionFilename: 'book.mp3' },
      operation: null,
    };

    test('deleting removes the request and its file, and keeps the cached audio', async () => {
      hoisted.resolveSession.mockResolvedValue(completeSession);
      hoisted.resolveArtifact.mockReset().mockResolvedValue(readyArtifact);
      const { json } = await start();
      expect(json.status).toBe('ready');

      expect((await remove(json.id)).status).toBe(204);

      expect(hoisted.deleteArtifact).toHaveBeenCalledWith({ artifactId: 'abcdef1234567890', storageUserId: 'user-1', documentId: 'doc-1' });
      expect(hoisted.cancelSession).not.toHaveBeenCalled();
      expect(hoisted.rows).toHaveLength(0);
      expect((await get(json.id)).status).toBe(404);
      expect((await remove(json.id)).status).toBe(404);
    });

    test('a file still being built cannot be deleted yet', async () => {
      hoisted.resolveSession.mockResolvedValue(completeSession);
      const { json } = await start();
      expect(json.artifact.state).toBe('building');
      hoisted.resolveArtifact.mockReset().mockResolvedValue(queuedArtifact);

      const refused = await remove(json.id);

      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('AUDIOBOOK_BUILDING');
      expect(hoisted.deleteArtifact).not.toHaveBeenCalled();
      expect(hoisted.rows).toHaveLength(1);
    });

    test('deleting stops a run only when no other format still needs it', async () => {
      hoisted.resolveSession.mockResolvedValue(running);
      const mp3 = (await start({ includeProgress: false })).json;
      const m4b = (await start({ includeProgress: false, format: 'm4b' })).json;

      expect((await remove(mp3.id)).status).toBe(204);
      expect(hoisted.cancelSession).not.toHaveBeenCalled();

      expect((await remove(m4b.id)).status).toBe(204);
      expect(hoisted.cancelSession).toHaveBeenCalledOnce();
      expect(hoisted.rows).toHaveLength(0);
    });

    test('lists a document\'s audiobooks with their speech settings and never advances one', async () => {
      hoisted.resolveSession.mockResolvedValue(completeSession);
      await start({ includeProgress: false });
      await start({ includeProgress: false, format: 'm4b' });
      hoisted.createArtifact.mockClear();
      hoisted.createAdmitted.mockClear();

      const page = await list('?limit=1');

      expect(page.status).toBe(200);
      expect(page.json.data).toHaveLength(1);
      expect(page.json.data[0]).toMatchObject({ provider: 'provider', model: 'tts-1', voice: 'alloy', modelSpeed: 1 });
      expect(Date.parse(page.json.data[0].requestedAt)).not.toBeNaN();
      expect(page.json.nextCursor).toBe('1');
      expect((await list('?cursor=1')).json).toMatchObject({ data: [expect.anything()], nextCursor: null });
      expect(hoisted.createAdmitted).not.toHaveBeenCalled();
      expect((await list('?limit=500')).status).toBe(400);
    });
  });

  test('responses match the published specification', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    // These tests name the document doc-1; the published ID format is checked elsewhere.
    const published = (json: Record<string, unknown>) => ({ ...json, documentId: 'a'.repeat(64) });
    const started = await start();
    expect(responseProblems('/documents/{id}/audiobooks', 'post', started.status, published(started.json))).toEqual([]);
    const found = await lookup();
    expect(responseProblems('/documents/{id}/audiobooks/lookup', 'post', found.status, published(found.json))).toEqual([]);
    const read = await get(started.json.id);
    expect(responseProblems('/documents/{id}/audiobooks/{audiobookId}', 'get', read.status, published(read.json))).toEqual([]);
    const listed = await list();
    expect(responseProblems('/documents/{id}/audiobooks', 'get', listed.status, { ...listed.json, data: listed.json.data.map(published) })).toEqual([]);
    const stopped = await stop(started.json.id);
    expect(responseProblems('/documents/{id}/audiobooks/{audiobookId}/cancel', 'post', stopped.status, published(stopped.json))).toEqual([]);
    const missing = await get('missing');
    expect(missing.status).toBe(404);
    expect(responseProblems('/documents/{id}/audiobooks/{audiobookId}', 'get', 404, missing.json)).toEqual([]);
    const invalid = await start({ speed: 9 });
    expect(responseProblems('/documents/{id}/audiobooks', 'post', 400, invalid.json)).toEqual([]);
  });

  test('asking again restarts the retention period', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    await start();
    hoisted.rows[0].createdAt = 1;
    await start();
    expect(hoisted.rows[0].createdAt).toBeGreaterThan(1);
  });

  describe('a failed build after retried skips', () => {
    const failedBuild = {
      artifact: { generatedSegments: 18, skippedSegments: 2 },
      operation: { opId: 'failed-build', status: 'failed', updatedAt: 100, error: { message: 'compile failed' } },
    };
    const finished = (updatedAt: number) => ({
      session: { status: 'succeeded' },
      operation: { opId: 'generation-op-1', status: 'succeeded', updatedAt },
      progress: null,
    });
    const failed = (updatedAt: number) => {
      hoisted.resolveSession.mockResolvedValue(finished(updatedAt));
      hoisted.exportProgress.mockResolvedValue(summary([chapter(0, 10), chapter(1, 10)]));
      hoisted.resolveArtifact.mockReset().mockResolvedValue(failedBuild);
    };

    test('a run that finished later is new work', async () => {
      failed(200);
      const { json } = await start();
      hoisted.createAdmitted.mockClear();
      hoisted.createArtifact.mockClear();

      await get(json.id);
      expect(hoisted.createArtifact).toHaveBeenCalledOnce();
    });

    test('the run that produced the failure does not loop on it', async () => {
      failed(50);
      const { json } = await start();
      hoisted.createAdmitted.mockClear();
      hoisted.createArtifact.mockClear();

      await get(json.id);
      expect(hoisted.createArtifact).not.toHaveBeenCalled();
    });
  });

  test('reading a chapter the document no longer has is not found', async () => {
    hoisted.resolveSession.mockResolvedValue(completeSession);
    const { json } = await start({ chapter: 0 });
    hoisted.exportProgress.mockResolvedValue(summary([]));

    const { status, json: body } = await get(json.id);
    expect(status).toBe(404);
    expect(body.error.code).toBe('CHAPTER_NOT_FOUND');
  });

  describe('retention', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const readyArtifact = { artifact: { dispositionFilename: 'book.mp3', generatedSegments: 20, skippedSegments: 0 }, operation: null };
    const prune = async () => {
      const { pruneSettledAudiobookRequests } = await import('@/lib/server/audiobooks/audiobooks');
      return pruneSettledAudiobookRequests(Date.now(), Date.now() + 60_000);
    };
    async function aged(days: number) {
      hoisted.resolveSession.mockResolvedValue(completeSession);
      hoisted.resolveArtifact.mockReset().mockResolvedValue(readyArtifact);
      await start();
      hoisted.rows[0].createdAt = Date.now() - days * DAY;
      hoisted.createAdmitted.mockClear();
      hoisted.createArtifact.mockClear();
    }

    test('a finished request is removed after seven days', async () => {
      await aged(8);
      expect(await prune()).toBe(1);
      expect(hoisted.rows).toHaveLength(0);
    });

    test('a finished request stays addressable before then', async () => {
      await aged(6);
      expect(await prune()).toBe(0);
      expect(hoisted.rows).toHaveLength(1);
    });

    test('a request whose document is gone is removed', async () => {
      await aged(8);
      const { resolveUserDocumentScope } = await import('@/lib/server/tts/segments-auth');
      vi.mocked(resolveUserDocumentScope).mockResolvedValueOnce(null);
      expect(await prune()).toBe(1);
      expect(hoisted.rows).toHaveLength(0);
    });

    test('a request that is still running stays, however old', async () => {
      await aged(30);
      hoisted.resolveSession.mockResolvedValue({
        session: { status: 'running' },
        operation: { opId: 'generation-op-1', status: 'running' },
        progress: null,
      });
      expect(await prune()).toBe(0);
      expect(hoisted.rows).toHaveLength(1);
    });

    test('checking an old request never starts work', async () => {
      await aged(8);
      hoisted.resolveArtifact.mockReset().mockResolvedValue(noArtifact);
      hoisted.createPlayback.mockClear();
      await prune();
      expect(hoisted.createAdmitted).not.toHaveBeenCalled();
      expect(hoisted.createArtifact).not.toHaveBeenCalled();
      expect(hoisted.createPlayback).not.toHaveBeenCalled();
    });

    test('a worker outage postpones the check', async () => {
      await aged(8);
      hoisted.resolveSession.mockRejectedValue(new TypeError('fetch failed'));
      expect(await prune()).toBe(0);
      expect(hoisted.rows).toHaveLength(1);
    });
  });
});
