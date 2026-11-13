import { NextRequest, NextResponse } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { ChapterNotFoundError, listAudiobooks, startAudiobook } from '@/lib/server/audiobooks/audiobooks';
import { parseAudiobookBody, resolveAudiobookCaller, resolveAudiobookIntent } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_LIMIT_MAX = 50;

/** A document's audiobooks, newest first. Listing reports them and never advances one. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const query = request.nextUrl.searchParams;
    const limit = Number(query.get('limit') ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
      return apiErrorResponse(400, 'REQUEST_INVALID', `limit must be between 1 and ${LIST_LIMIT_MAX}.`);
    }
    const documentId = (await context.params).id.trim().toLowerCase();
    const caller = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (caller instanceof Response) return caller;
    return NextResponse.json(await listAudiobooks({ ...caller, mayGenerate: false }, documentId, { limit, cursor: query.get('cursor') }));
  } catch (error) {
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.list_failed',
      msg: 'Failed to list audiobooks',
      normalize: { code: 'AUDIOBOOK_LIST_FAILED', errorClass: 'unknown' },
    });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const documentId = (await context.params).id.trim().toLowerCase();
    const body = parseAudiobookBody(await request.json().catch(() => null));
    if (body instanceof Response) return body;
    const retrySkipped = body.record.retrySkipped === true;
    if (retrySkipped && body.chapterIndex !== null) {
      return apiErrorResponse(400, 'REQUEST_INVALID', 'retrySkipped applies to a whole book.');
    }
    const caller = await resolveAudiobookCaller(request, documentId, 'audio:generate');
    if (caller instanceof Response) return caller;
    const intent = await resolveAudiobookIntent(caller, documentId, body);
    if (intent instanceof Response) return intent;
    const audiobook = await startAudiobook(caller, intent, {
      retrySkipped,
      includeProgress: body.record.includeProgress !== false,
    });
    logger.info?.({
      event: 'audiobooks.started',
      generationState: audiobook.generation.state,
      artifactState: audiobook.artifact.state,
    }, 'Audiobook requested');
    return NextResponse.json(audiobook, { status: audiobook.status === 'ready' ? 200 : 202 });
  } catch (error) {
    if (error instanceof ChapterNotFoundError) return apiErrorResponse(404, 'CHAPTER_NOT_FOUND', error.message);
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.start_failed',
      msg: 'Failed to start the audiobook',
      normalize: { code: 'AUDIOBOOK_START_FAILED', errorClass: 'unknown' },
    });
  }
}
