import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { TASK_REGISTRY } from '@/lib/server/tasks/registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;

  const { key } = await params;
  if (!Object.hasOwn(TASK_REGISTRY, key)) {
    return NextResponse.json({ error: 'Unknown task' }, { status: 404 });
  }

  const ran = await runTaskNow(key);
  return NextResponse.json({ ran });
}
