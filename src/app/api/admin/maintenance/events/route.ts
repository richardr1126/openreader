import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<Response> {
  const context = await requireAdminContext(request);
  if (context instanceof Response) return context;
  const opId = request.nextUrl.searchParams.get('opId');
  if (!opId || opId.length > 256) return NextResponse.json({ error: 'Invalid operation ID' }, { status: 400 });
  try {
    const operation = await getComputeWorkerClient().getOperation(opId, { signal: AbortSignal.timeout(10_000) });
    if (!operation) return new Response('event: unavailable\ndata: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    });
    if (operation.subject.kind !== 'maintenance') return NextResponse.json({ error: 'Not a maintenance operation' }, { status: 403 });
    return await proxyOperationEvents({ request, opId, streamErrorMessage: 'Unable to read cleanup progress' });
  } catch (error) {
    return errorResponse(error, { apiErrorMessage: 'Unable to read cleanup progress', normalize: { code: 'MAINTENANCE_EVENTS_FAILED', errorClass: 'upstream' } });
  }
}
