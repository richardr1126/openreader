import { NextRequest, NextResponse } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { ChapterNotFoundError, lookupAudiobook } from '@/lib/server/audiobooks/audiobooks';
import { parseAudiobookBody, resolveAudiobookCaller, resolveAudiobookIntent } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Finds the audiobook for some settings. It is a POST because settings do not fit a URL. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/lookup', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const documentId = (await context.params).id.trim().toLowerCase();
    const body = parseAudiobookBody(await request.json().catch(() => null));
    if (body instanceof Response) return body;
    const resolved = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (resolved instanceof Response) return resolved;
    const intent = await resolveAudiobookIntent(resolved.caller, documentId, body);
    if (intent instanceof Response) return intent;
    const audiobook = await lookupAudiobook(resolved.caller, intent, {
      includeProgress: body.record.includeProgress !== false || body.chapterIndex !== null,
    });
    return resolved.finish(NextResponse.json(audiobook));
  } catch (error) {
    if (error instanceof ChapterNotFoundError) return apiErrorResponse(404, 'CHAPTER_NOT_FOUND', error.message);
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.lookup_failed',
      msg: 'Failed to look up the audiobook',
      normalize: { code: 'AUDIOBOOK_LOOKUP_FAILED', errorClass: 'unknown' },
    });
  }
}
