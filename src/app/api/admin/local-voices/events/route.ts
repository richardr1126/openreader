import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context as NextResponse;
  const opId = request.nextUrl.searchParams.get('opId')?.trim();
  if (!opId) return NextResponse.json({ error: 'opId is required' }, { status: 400 });
  const operation = await getComputeWorkerClient().getOperation(opId);
  if (!operation || operation.subject.kind !== 'model_download') {
    return NextResponse.json({ error: 'Model download not found' }, { status: 404 });
  }
  return proxyOperationEvents({ request, opId, streamErrorMessage: 'Unable to stream the model download' });
}
