import { expect, test, vi } from 'vitest';

// A query builder that chains like drizzle's and rejects only when awaited.
function failingQuery(): PromiseLike<never> & Record<string, unknown> {
  const query: PromiseLike<never> & Record<string, unknown> = {
    then: (onFulfilled, onRejected) => Promise.reject(new Error('database unavailable')).then(onFulfilled, onRejected),
  };
  for (const method of ['from', 'where', 'orderBy', 'limit']) query[method] = () => query;
  return query;
}

vi.mock('@openreader/database', () => ({ db: { select: () => failingQuery() } }));

const { getRuntimeConfigWithSources, getRuntimeConfig } = await import('@/lib/server/admin/settings');

test('an admin read-back fails instead of returning a fallback snapshot', async () => {
  await expect(getRuntimeConfigWithSources()).rejects.toThrow('database unavailable');
});

test('a runtime read still degrades to a fallback when the database is unavailable', async () => {
  await expect(getRuntimeConfig()).resolves.toBeTruthy();
});
