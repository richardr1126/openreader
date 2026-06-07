import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { updateTask } from '@/lib/server/tasks/engine';
import { TASK_REGISTRY } from '@/lib/server/tasks/registry';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const { key } = await params;
  if (!(key in TASK_REGISTRY)) {
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

  const { enabled, intervalMs } = body as { enabled?: unknown; intervalMs?: unknown };
  const patch: { enabled?: boolean; intervalMs?: number } = {};
  if (typeof enabled === 'boolean') patch.enabled = enabled;
  if (typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0) {
    patch.intervalMs = Math.floor(intervalMs);
  }

  await updateTask(key, patch);
  return NextResponse.json({ ok: true });
}
