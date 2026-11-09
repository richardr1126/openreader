import { NextRequest, NextResponse } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { resolveAudiobookCaller } from '@/lib/server/audiobooks/request';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { listCachedVoices } from '@/lib/server/tts/cached-voices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/cached-voices', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for cached audio.');
    }
    const documentId = (await context.params).id.trim().toLowerCase();
    const caller = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (caller instanceof Response) return caller;
    const voices = await listCachedVoices(caller, documentId);
    if (voices instanceof Response) return voices;
    return NextResponse.json({ data: voices, nextCursor: null });
  } catch (error) {
    return apiCatchResponse(error, {
      logger,
      event: 'tts.cached_voices.failed',
      msg: 'Failed to list cached voices',
      normalize: { code: 'CACHED_VOICES_FAILED', errorClass: 'unknown' },
    });
  }
}
