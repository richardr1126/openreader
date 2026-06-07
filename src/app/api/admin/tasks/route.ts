import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { listTasks } from '@/lib/server/tasks/engine';
import { getTaskSchedulerInfo } from '@/lib/server/tasks/scheduler';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const scheduler = getTaskSchedulerInfo();
  const tasks = (await listTasks()).map((task) => ({
    ...task,
    intervalMs: Math.max(task.intervalMs, scheduler.minimumIntervalMs),
  }));
  return NextResponse.json({ tasks, scheduler });
}
