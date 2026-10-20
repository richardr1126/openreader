import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'bucket' }),
  getS3InternalClient: () => ({ send: mocks.send }),
}));
vi.mock('@/lib/server/compute-worker/client', () => ({ getComputeWorkerClient: vi.fn() }));

import { readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';

const body = JSON.stringify({ schemaVersion: 1, segments: [{ ordinal: 0, text: 'A sentence.' }] });

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ Body: { transformToString: async () => body } });
});

test('reads an immutable plan artifact once per object key', async () => {
  const first = await readTtsPlaybackPlanArtifact('plans/cached.json');
  const second = await readTtsPlaybackPlanArtifact('plans/cached.json');
  expect(second).toBe(first);
  expect(first.artifact.segments).toHaveLength(1);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('retries a plan artifact whose read failed', async () => {
  mocks.send.mockRejectedValueOnce(new Error('unavailable'));
  await expect(readTtsPlaybackPlanArtifact('plans/flaky.json')).rejects.toThrow('unavailable');
  await expect(readTtsPlaybackPlanArtifact('plans/flaky.json')).resolves.toMatchObject({ body });
  expect(mocks.send).toHaveBeenCalledTimes(2);
});
