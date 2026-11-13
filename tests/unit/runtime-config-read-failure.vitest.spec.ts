import { expect, test, vi } from 'vitest';

vi.mock('@openreader/database', () => ({
  db: { select: () => ({ from: () => Promise.reject(new Error('database unavailable')) }) },
}));

const { getRuntimeConfigWithSources, getRuntimeConfig } = await import('@/lib/server/admin/settings');

test('an admin read-back fails instead of returning a fallback snapshot', async () => {
  await expect(getRuntimeConfigWithSources()).rejects.toThrow('database unavailable');
});

test('a runtime read still degrades to a fallback when the database is unavailable', async () => {
  await expect(getRuntimeConfig()).resolves.toBeTruthy();
});
