import { expect, test, vi } from 'vitest';

const expiration = vi.hoisted(() => vi.fn(async () => ({ expiredArtifacts: 2, deletedObjects: 6 })));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => true,
  getComputeWorkerClient: () => ({ expireAccountExportArtifacts: expiration }),
}));

test('the daily expiry task keeps audiobooks and expires only temporary account exports', async () => {
  const { expireExportArtifacts } = await import('@/lib/server/tasks/handlers/expire-export-artifacts');
  const signal = new AbortController().signal;
  const result = await expireExportArtifacts({ signal } as never);
  expect(expiration).toHaveBeenCalledExactlyOnceWith({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 }, { signal });
  expect(result).toMatchObject({ expiredArtifacts: 2, deletedObjects: 6 });
});
