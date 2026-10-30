import { describe, expect, test, vi } from 'vitest';
import { createMaintenanceHandler } from '../../src/jobs/maintenance';
import type { ArtifactStorage, StoredObjectSummary } from '../../src/infrastructure/storage';
import type { registerCleanupRoutes } from '../../src/api/routes/cleanup';

const documentId = 'a'.repeat(64);
const otherDocumentId = 'b'.repeat(64);

function setup(objects: StoredObjectSummary[] = []) {
  const deleted: string[] = [];
  const storage = {
    async *listPrefixPages(prefix: string) { yield objects.filter((object) => object.key.startsWith(prefix)); },
    listPrefix: vi.fn(async () => []),
    listChildPrefixes: vi.fn(async () => []),
    deleteObject: vi.fn(async (key: string) => { deleted.push(key); }),
  } as unknown as ArtifactStorage;
  const cleanup = {
    cleanupUserStorage: vi.fn(async () => ({ deletedObjects: 0, deletedDocumentArtifacts: 0 })),
    clearPlaybackScope: vi.fn(async () => ({})),
  } as unknown as ReturnType<typeof registerCleanupRoutes>;
  const step = vi.fn(async (_body: Record<string, unknown>): Promise<unknown> => ({ ok: true }));
  const progress = vi.fn(async () => undefined);
  const run = createMaintenanceHandler({
    storage, s3Prefix: 'test', cleanup,
    databaseStep: step as Parameters<typeof createMaintenanceHandler>[0]['databaseStep'],
    logger: { warn: vi.fn() },
  });
  return { storage, cleanup, step, progress, deleted, run };
}

describe('durable maintenance execution', () => {
  test('deletes storage before SQL completion and publishes progress for a whole selected batch', async () => {
    const { run, step, cleanup, progress } = setup();
    const result = await run({ task: 'delete-users', runId: 'run', userIds: ['u1', 'u2'] }, 0, { onProgress: progress });
    expect(result).toMatchObject({ completed: 2, failed: 0 });
    expect(cleanup.cleanupUserStorage).toHaveBeenNthCalledWith(1, { storageUserId: 'u1', namespace: null, documentIds: [] });
    expect(step).toHaveBeenNthCalledWith(1, { action: 'finalize-user', userId: 'u1' });
    expect(vi.mocked(cleanup.cleanupUserStorage).mock.invocationCallOrder[0]).toBeLessThan(step.mock.invocationCallOrder[0]);
    expect(progress).toHaveBeenLastCalledWith({ phase: 'Deleting accounts', completed: 2, failed: 0 });
  });

  test('retries transient failures, retains persistent failures and keeps deleting the rest', async () => {
    const { run, step, cleanup, progress } = setup();
    const tries = new Map<string, number>();
    vi.mocked(cleanup.cleanupUserStorage).mockImplementation(async ({ storageUserId }) => {
      const attempt = (tries.get(storageUserId) ?? 0) + 1;
      tries.set(storageUserId, attempt);
      if (storageUserId === 'broken' || (storageUserId === 'transient' && attempt === 1)) throw new Error('storage unavailable');
      return { deletedObjects: 0, deletedDocumentArtifacts: 0 };
    });
    const result = await run({ task: 'delete-users', runId: 'run', userIds: ['broken', 'transient', 'healthy'] }, 0, { onProgress: progress });
    expect(result).toMatchObject({ completed: 2, failed: 1 });
    expect(step).not.toHaveBeenCalledWith({ action: 'finalize-user', userId: 'broken' });
    expect(step).toHaveBeenCalledWith({ action: 'finalize-user', userId: 'healthy' });
    expect(tries.get('broken')).toBe(3);
  });

  test('guest cleanup drains bounded database pages including previously marked accounts', async () => {
    const { run, step, cleanup } = setup();
    step.mockImplementation(async (body) => body.action !== 'claim-users' ? { ok: true }
      : body.after === null ? { userIds: ['old-pending', 'recently-idle'] } : { userIds: [] });
    const result = await run({ task: 'expire-anonymous-users', idleBefore: 1234, runId: 'run' }, 0);
    expect(result.completed).toBe(2);
    expect(step).toHaveBeenCalledWith({ action: 'claim-users', after: 'recently-idle', idleBefore: 1234 });
    expect(cleanup.cleanupUserStorage).toHaveBeenCalledTimes(2);
  });

  test('failed SQL completion is retryable after storage has already been removed', async () => {
    const { run, step, cleanup } = setup();
    step.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await run({ task: 'delete-users', runId: 'run', userIds: ['u1'] }, 0);
    expect(result).toMatchObject({ completed: 1, failed: 0 });
    expect(cleanup.cleanupUserStorage).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenCalledTimes(2);
  });

  test('reaper preserves young and owned blobs and deletes source objects last', async () => {
    const now = Date.now();
    const young = 'c'.repeat(64);
    const { run, step, storage, deleted } = setup([
      { key: `test/documents_v1/${documentId}`, lastModifiedMs: now - 7_200_000, size: 1 },
      { key: `test/documents_v1/${otherDocumentId}`, lastModifiedMs: now - 7_200_000, size: 1 },
      { key: `test/documents_v1/${young}`, lastModifiedMs: now, size: 1 },
    ]);
    vi.mocked(storage.listPrefix).mockImplementation(async (prefix) => [`${prefix}derived`]);
    step.mockImplementation(async (body) => body.action === 'reap-claim'
      ? { owner: body.documentId === documentId ? 'lease' : null } : { ok: true, renewed: true });
    const result = await run({ task: 'reap-orphaned-blobs', runId: 'run' }, 0);
    expect(result.completed).toBe(1);
    expect(deleted.at(-1)).toBe(`test/documents_v1/${documentId}`);
    expect(deleted).not.toContain(`test/documents_v1/${otherDocumentId}`);
    expect(step).not.toHaveBeenCalledWith({ action: 'reap-claim', documentId: young });
    expect(step).toHaveBeenCalledWith({ action: 'reap-release', documentId, owner: 'lease' });
  });

  test('export retention removes account ZIPs and preserves audiobook storage', async () => {
    const { run, deleted } = setup([
      { key: 'test/account_exports_v1/users/u/export/archive.zip', lastModifiedMs: Date.now() - 8 * 86_400_000, size: 1 },
      { key: 'test/tts_playback_exports_v1/users/u/book.m4b', lastModifiedMs: Date.now() - 8 * 86_400_000, size: 1 },
    ]);
    const result = await run({ task: 'expire-export-artifacts', runId: 'run' }, 0);
    expect(result.completed).toBe(1);
    expect(deleted).toEqual(['test/account_exports_v1/users/u/export/archive.zip']);
  });
});
