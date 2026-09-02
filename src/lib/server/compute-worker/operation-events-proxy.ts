import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';

/**
 * Forward the worker's generic operation-events SSE stream through a Next
 * route. Callers own auth and operation-scope validation; this owns only the
 * reconnectable stream plumbing (Last-Event-ID resume, SSE headers, upstream
 * failure mapping) so every proxy route behaves identically.
 */
export async function proxyOperationEvents(input: {
  request: NextRequest;
  opId: string;
  streamErrorMessage: string;
}): Promise<NextResponse> {
  const { request, opId, streamErrorMessage } = input;
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
      { error: detail || streamErrorMessage },
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
}
