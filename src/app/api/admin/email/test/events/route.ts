import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context as NextResponse;
  const opId = request.nextUrl.searchParams.get('opId')?.trim();
  if (!opId) return NextResponse.json({ error: 'opId is required' }, { status: 400 });
  const operation = await getComputeWorkerClient().getOperation(opId);
  if (!operation || operation.subject.kind !== 'email_delivery') {
    return NextResponse.json({ error: 'Email delivery operation not found' }, { status: 404 });
  }
  return proxyOperationEvents({ request, opId, streamErrorMessage: 'Unable to stream email delivery status' });
}
