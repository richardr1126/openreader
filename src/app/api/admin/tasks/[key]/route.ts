import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { updateTask } from '@/lib/server/tasks/engine';
import { TASK_REGISTRY } from '@/lib/server/tasks/registry';
import { getTaskSchedulerInfo } from '@/lib/server/tasks/scheduler';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const { key } = await params;
  if (!Object.hasOwn(TASK_REGISTRY, key)) {
    return NextResponse.json({ error: 'Unknown task' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Expected JSON object' }, { status: 400 });
  }

  const payload = body as { enabled?: unknown; intervalMs?: unknown };
  const patch: { enabled?: boolean; intervalMs?: number } = {};
  if (Object.hasOwn(payload, 'enabled')) {
    if (typeof payload.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    patch.enabled = payload.enabled;
  }
  if (Object.hasOwn(payload, 'intervalMs')) {
    if (
      typeof payload.intervalMs !== 'number'
      || !Number.isFinite(payload.intervalMs)
      || payload.intervalMs <= 0
    ) {
      return NextResponse.json({ error: 'intervalMs must be a finite positive number' }, { status: 400 });
    }
    patch.intervalMs = Math.max(1, Math.floor(payload.intervalMs));
    const minimumIntervalMs = getTaskSchedulerInfo().minimumIntervalMs;
    if (patch.intervalMs < minimumIntervalMs) {
      return NextResponse.json(
        { error: `intervalMs must be at least ${minimumIntervalMs} for this deployment` },
        { status: 400 },
      );
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Expected enabled or intervalMs' }, { status: 400 });
  }

  await updateTask(key, patch);
  return NextResponse.json({ ok: true });
}
