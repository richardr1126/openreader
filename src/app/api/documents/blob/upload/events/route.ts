import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidTempUploadToken } from '@/lib/server/documents/blobstore';
import {
  buildDocxConversionRequest,
  headTempUploadForConversion,
} from '@/lib/server/documents/docx-conversion-jobs';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/documents/blob/upload/events',
    request,
  });

  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for DOCX conversion.' },
        { status: 503 },
      );
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const opId = request.nextUrl.searchParams.get('opId')?.trim() ?? '';
    const token = request.nextUrl.searchParams.get('token')?.trim().toLowerCase() ?? '';
    if (!opId || !isValidTempUploadToken(token)) {
      return NextResponse.json({ error: 'A valid opId and upload token are required' }, { status: 400 });
    }

    const namespace = null;
    const temp = await headTempUploadForConversion({
      token,
      userId: ctxOrRes.userId,
      namespace,
    });
    const conversionRequest = buildDocxConversionRequest({
      upload: { token },
      temp,
      userId: ctxOrRes.userId,
      namespace,
    });

    const operation = await getComputeWorkerClient().getOperation(opId);
    if (!operation) return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
    if (
      operation.subject.kind !== 'document_conversion'
      || operation.subject.conversionId !== conversionRequest.conversionId
      || operation.subject.namespace !== namespace
    ) {
      return NextResponse.json({ error: 'Operation does not belong to this upload' }, { status: 403 });
    }

    return await proxyOperationEvents({
      request,
      opId,
      streamErrorMessage: 'Failed to proxy DOCX conversion event stream',
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'documents.upload.events_failed',
      msg: 'Failed to proxy DOCX conversion events',
      apiErrorMessage: 'Failed to proxy DOCX conversion events',
      normalize: { code: 'DOCUMENTS_UPLOAD_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}
