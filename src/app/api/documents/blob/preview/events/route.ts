import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';
import { validatePreviewRequest } from '../utils';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/documents/blob/preview/events',
    request: req,
  });

  try {
    const validation = await validatePreviewRequest(req);
    if (validation.errorResponse) return validation.errorResponse;
    const { id, testNamespace } = validation;

    const opId = (req.nextUrl.searchParams.get('opId') || '').trim();
    if (!opId) {
      return NextResponse.json({ error: 'opId is required' }, { status: 400 });
    }

    const client = getComputeWorkerClient();
    const operation = await client.getOperation(opId);
    if (!operation) return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
    if (
      operation.subject.kind !== 'document_preview'
      || operation.subject.documentId !== id
      || operation.subject.namespace !== testNamespace
      || operation.subject.previewKind !== 'card'
    ) {
      return NextResponse.json({ error: 'Operation does not belong to this preview' }, { status: 403 });
    }

    return await proxyOperationEvents({
      request: req,
      opId,
      streamErrorMessage: 'Failed to proxy preview event stream',
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'documents.preview.events_failed',
      msg: 'Failed to proxy document preview events',
      apiErrorMessage: 'Failed to proxy document preview events',
      normalize: { code: 'DOCUMENTS_PREVIEW_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}
