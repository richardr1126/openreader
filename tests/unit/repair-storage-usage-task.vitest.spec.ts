import { beforeEach, expect, test, vi } from 'vitest';

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/tasks/enqueue-maintenance', () => ({ enqueueMaintenanceTask: enqueue }));

const context = { runId: 'run', signal: new AbortController().signal, cursor: null, deadlineAt: Date.now() + 1_000 };
const run = async () => (await import('@/lib/server/tasks/registry')).TASK_REGISTRY['repair-storage-usage'].run(context);

beforeEach(() => enqueue.mockReset());

test('a queued repair records that the backfill has started', async () => {
  enqueue.mockResolvedValue({ operationId: 'op', summary: 'Queued for cleanup' });
  expect(await run()).toMatchObject({ operationId: 'op', cursor: expect.any(String) });
});

test('a skipped repair leaves the backfill to run later', async () => {
  enqueue.mockResolvedValue({ summary: 'Skipped: object storage not configured' });
  expect(await run()).toEqual({ summary: 'Skipped: object storage not configured' });
});
