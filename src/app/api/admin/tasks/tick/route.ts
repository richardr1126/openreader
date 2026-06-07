import { NextRequest, NextResponse } from 'next/server';
import { runDueTasks } from '@/lib/server/tasks/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Cron-driven tick for serverless (Vercel) deployments. Vercel automatically
 * sends `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations, so we
 * require that secret. Self-hosted deployments drive ticks via the in-process
 * scheduler and don't need this route.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Cron not configured' }, { status: 503 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await runDueTasks();
  return NextResponse.json({ ok: true });
}
