import { NextRequest, NextResponse } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { AudiobookBuildingError, ChapterNotFoundError, deleteAudiobook, getAudiobook } from '@/lib/server/audiobooks/audiobooks';
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
    const caller = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (caller instanceof Response) return caller;
    const audiobook = await getAudiobook(caller, audiobookId, documentId);
    if (!audiobook) return notFound();
    return NextResponse.json(audiobook);
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

/**
 * Deletes the audiobook and its built file. The document's cached speech stays,
 * so asking for the same audiobook again rebuilds the file without new speech.
 */
export async function DELETE(request: NextRequest, context: Context) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/[audiobookId]', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const { id, audiobookId } = await context.params;
    const documentId = id.trim().toLowerCase();
    const caller = await resolveAudiobookCaller(request, documentId, 'documents:write');
    if (caller instanceof Response) return caller;
    if (!await deleteAudiobook(caller, audiobookId, documentId)) return notFound();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AudiobookBuildingError) return apiErrorResponse(409, 'AUDIOBOOK_BUILDING', error.message);
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.delete_failed',
      msg: 'Failed to delete the audiobook',
      normalize: { code: 'AUDIOBOOK_DELETE_FAILED', errorClass: 'unknown' },
    });
  }
}
