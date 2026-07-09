import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { auth } from '@/lib/server/auth/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/user/export/events',
    request,
  });
  try {
    if (!auth) {
      return NextResponse.json({ error: 'Auth not initialized' }, { status: 500 });
    }
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for account export.' },
        { status: 503 },
      );
    }

    const opId = request.nextUrl.searchParams.get('opId')?.trim() ?? '';
    if (!opId) return NextResponse.json({ error: 'opId is required' }, { status: 400 });

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const operation = await getComputeWorkerClient().getOperation(opId);
    if (!operation) return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
    if (operation.subject.kind !== 'account_export') {
      return NextResponse.json({ error: 'Operation does not belong to this account export' }, { status: 403 });
    }
    if (
      operation.subject.storageUserId !== session.user.id
      || operation.subject.namespace !== getOpenReaderTestNamespace(request.headers)
    ) {
      return NextResponse.json({ error: 'Operation does not belong to this account export' }, { status: 403 });
    }

    const lastEventId = request.headers.get('last-event-id');
    const sinceEventId = request.nextUrl.searchParams.get('sinceEventId') || lastEventId;
    const upstream = await getComputeWorkerClient().openOperationEvents(opId, {
      sinceEventId,
      lastEventId,
      signal: request.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: detail || 'Failed to proxy account export event stream' },
        { status: upstream.status || 502 },
      );
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
        'Cache-Control': upstream.headers.get('cache-control') || 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'user.export.events_failed',
      msg: 'Failed to proxy account export events',
      apiErrorMessage: 'Failed to proxy account export events',
      normalize: { code: 'USER_EXPORT_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}
