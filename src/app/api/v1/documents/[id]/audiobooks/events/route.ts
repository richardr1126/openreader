import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { computeLimitAdmissions } from '@openreader/database/schema';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { resolveAudiobookCaller } from '@/lib/server/audiobooks/request';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';
import { createRequestLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/events', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const documentId = (await context.params).id.trim().toLowerCase();
    const opId = request.nextUrl.searchParams.get('opId')?.trim() ?? '';
    if (!opId) return apiErrorResponse(400, 'REQUEST_INVALID', 'opId is required.');

    const resolved = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (resolved instanceof Response) return resolved;

    const operation = await getComputeWorkerClient().getOperation(opId);
    if (!operation) return apiErrorResponse(404, 'OPERATION_NOT_FOUND', 'Operation not found.');
    if (
      !['tts_playback_export', 'tts_playback', 'tts_playback_plan'].includes(operation.subject.kind)
      || !('documentId' in operation.subject)
      || operation.subject.documentId !== documentId
    ) {
      return apiErrorResponse(403, 'OPERATION_FORBIDDEN', 'Operation does not belong to this document.');
    }

    // Document IDs identify content and can be shared by different owners.
    // The admission links this operation to its actual user, including plans
    // and artifacts whose public operation subject has no owner field.
    const admissions = await db.select({ id: computeLimitAdmissions.id }).from(computeLimitAdmissions).where(and(
      eq(computeLimitAdmissions.operationId, opId),
      eq(computeLimitAdmissions.userId, resolved.caller.scope.userId),
    )).limit(1);
    if (!admissions[0]) return apiErrorResponse(403, 'OPERATION_FORBIDDEN', 'Operation does not belong to this user.');

    return await proxyOperationEvents({
      request,
      opId,
      streamErrorMessage: 'Failed to proxy audiobook event stream',
    }) as NextResponse;
  } catch (error) {
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.events_failed',
      msg: 'Failed to proxy audiobook events',
      normalize: { code: 'AUDIOBOOK_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}
