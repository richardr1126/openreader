import { NextRequest, NextResponse } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { ChapterCommandError, stopAudiobook } from '@/lib/server/audiobooks/audiobooks';
import { resolveAudiobookCaller } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; audiobookId: string }> };

/** Stops generating the audiobook. Cached speech stays; asking for it again resumes from there. */
export async function POST(request: NextRequest, context: Context) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/[audiobookId]/cancel', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    const { id, audiobookId } = await context.params;
    const documentId = id.trim().toLowerCase();
    const caller = await resolveAudiobookCaller(request, documentId, 'audio:generate');
    if (caller instanceof Response) return caller;
    const audiobook = await stopAudiobook(caller, audiobookId, documentId);
    if (!audiobook) return apiErrorResponse(404, 'AUDIOBOOK_NOT_FOUND', 'Audiobook not found.');
    return NextResponse.json(audiobook);
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
