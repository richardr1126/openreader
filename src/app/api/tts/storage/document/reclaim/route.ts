import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { resolveDocumentStorageScope } from '@/lib/server/tts/storage-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Reclaim a document's audio generated with other settings or older document
 * versions. The current cache identity, its sessions, and the shared reading
 * plan are kept, so active playback with the current settings is unaffected.
 */
export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/storage/document/reclaim', request });
  try {
    const resolved = await resolveDocumentStorageScope(request);
    if (resolved instanceof Response) return resolved;
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required to reclaim audio.' }, { status: 503 });
    }
    const result = await getComputeWorkerClient().reclaimTtsPlaybackCache({
      storageUserId: resolved.scope.storageUserId,
      documentId: resolved.documentId,
      keep: {
        documentVersion: resolved.scope.documentVersion,
        settingsHash: resolved.settingsHash,
      },
    }, { signal: AbortSignal.timeout(45_000) });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.storage.document_reclaim_failed',
      msg: 'Failed to reclaim unused document audio',
      apiErrorMessage: 'Failed to reclaim unused audio',
      normalize: { code: 'TTS_STORAGE_RECLAIM_FAILED', errorClass: 'storage' },
    });
  }
}
