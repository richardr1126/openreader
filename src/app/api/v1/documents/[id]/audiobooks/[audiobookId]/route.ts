import { NextRequest, NextResponse } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { ChapterCommandError, ChapterNotFoundError, getAudiobook, stopAudiobook } from '@/lib/server/audiobooks/audiobooks';
import { resolveAudiobookCaller } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; audiobookId: string }> };

function notFound() {
  return apiErrorResponse(404, 'AUDIOBOOK_NOT_FOUND', 'Audiobook not found.');
}

export async function GET(request: NextRequest, context: Context) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/[audiobookId]', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const { id, audiobookId } = await context.params;
    const documentId = id.trim().toLowerCase();
    const resolved = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (resolved instanceof Response) return resolved;
    const audiobook = await getAudiobook(resolved.caller, audiobookId, documentId);
    if (!audiobook) return notFound();
    return resolved.finish(NextResponse.json(audiobook));
  } catch (error) {
    if (error instanceof ChapterNotFoundError) return apiErrorResponse(404, 'CHAPTER_NOT_FOUND', error.message);
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.get_failed',
      msg: 'Failed to read the audiobook',
      normalize: { code: 'AUDIOBOOK_GET_FAILED', errorClass: 'unknown' },
    });
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/[audiobookId]', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const { id, audiobookId } = await context.params;
    const documentId = id.trim().toLowerCase();
    const resolved = await resolveAudiobookCaller(request, documentId, 'audio:generate');
    if (resolved instanceof Response) return resolved;
    const audiobook = await stopAudiobook(resolved.caller, audiobookId, documentId);
    if (!audiobook) return notFound();
    return resolved.finish(NextResponse.json(audiobook));
  } catch (error) {
    if (error instanceof ChapterCommandError) return apiErrorResponse(400, 'REQUEST_INVALID', error.message);
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.stop_failed',
      msg: 'Failed to stop the audiobook',
      normalize: { code: 'AUDIOBOOK_STOP_FAILED', errorClass: 'unknown' },
    });
  }
}
