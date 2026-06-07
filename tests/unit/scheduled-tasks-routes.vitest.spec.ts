import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  listTasks: vi.fn(),
  runDueTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock('@/lib/server/auth/admin', () => ({
  requireAdminContext: mocks.requireAdminContext,
}));
vi.mock('@/lib/server/tasks/engine', () => ({
  listTasks: mocks.listTasks,
  runDueTasks: mocks.runDueTasks,
  updateTask: mocks.updateTask,
}));

describe('scheduled task routes', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalVercel = process.env.VERCEL;

  beforeEach(() => {
    mocks.requireAdminContext.mockReset();
    mocks.requireAdminContext.mockResolvedValue({ userId: 'admin-1' });
    mocks.listTasks.mockReset();
    mocks.listTasks.mockResolvedValue([]);
    mocks.runDueTasks.mockReset();
    mocks.runDueTasks.mockResolvedValue(undefined);
    mocks.updateTask.mockReset();
    mocks.updateTask.mockResolvedValue(undefined);
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL;
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  test('cron tick requires the configured bearer secret', async () => {
    const { GET } = await import('../../src/app/api/admin/tasks/tick/route');

    const unconfigured = await GET(new NextRequest('http://localhost/api/admin/tasks/tick'));
    expect(unconfigured.status).toBe(503);

    process.env.CRON_SECRET = 'cron-secret';
    const unauthorized = await GET(new NextRequest('http://localhost/api/admin/tasks/tick'));
    expect(unauthorized.status).toBe(401);

    const authorized = await GET(new NextRequest('http://localhost/api/admin/tasks/tick', {
      headers: { authorization: 'Bearer cron-secret' },
    }));
    expect(authorized.status).toBe(200);
    expect(mocks.runDueTasks).toHaveBeenCalledTimes(1);
  });

  test('admin task list enforces admin authorization', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    mocks.requireAdminContext.mockResolvedValue(denied);
    const { GET } = await import('../../src/app/api/admin/tasks/route');

    const response = await GET(new NextRequest('http://localhost/api/admin/tasks'));

    expect(response).toBe(denied);
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  test('reports daily Vercel cadence and rejects shorter intervals', async () => {
    process.env.VERCEL = '1';
    mocks.listTasks.mockResolvedValue([{
      key: 'cleanup-temp-uploads',
      intervalMs: 60 * 60 * 1000,
    }]);
    const { GET } = await import('../../src/app/api/admin/tasks/route');
    const listResponse = await GET(new NextRequest('http://localhost/api/admin/tasks'));
    await expect(listResponse.json()).resolves.toMatchObject({
      tasks: [{ intervalMs: 86_400_000 }],
      scheduler: {
        mode: 'vercel-cron',
        minimumIntervalMs: 86_400_000,
      },
    });

    const { PATCH } = await import('../../src/app/api/admin/tasks/[key]/route');
    const patchResponse = await PATCH(new NextRequest('http://localhost/api/admin/tasks/cleanup-temp-uploads', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMs: 60 * 60 * 1000 }),
    }), { params: Promise.resolve({ key: 'cleanup-temp-uploads' }) });

    expect(patchResponse.status).toBe(400);
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
});
