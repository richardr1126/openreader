import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { getComputeWorkerClient, isComputeWorkerUnavailableError } from '@/lib/server/compute-worker/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;
  try {
    return NextResponse.json(await getComputeWorkerClient().cancelModelDownload('kokoro-82m'));
  } catch (error) {
    if (isComputeWorkerUnavailableError(error)) {
      return NextResponse.json({ error: 'The compute worker is not reachable right now.' }, { status: 503 });
    }
    throw error;
  }
}
