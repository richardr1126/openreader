import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { filterOwnedDocumentIds, listOwnedDocumentIds } from '@/lib/server/tts/storage-scope';
import { LIBRARY_RECLAIM_DOCUMENT_BATCH, orphanedAudioDocumentIds } from '@/lib/server/tts/storage-usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type ReclaimTarget = 'orphaned' | 'all';

function parseTarget(value: unknown): ReclaimTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = (value as Record<string, unknown>).target;
  return target === 'orphaned' || target === 'all' ? target : null;
}

/**
 * Delete library audio in bounded batches. `orphaned` removes audio left by
 * documents the user no longer has; `all` removes every document's audio. Each
 * document goes through the worker's playback reset boundary, which leaves
 * shared reading plans and document data alone. The response reports how many
 * documents remain so the client can repeat until done.
 */
export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/storage/reclaim', request });
  try {
    const target = parseTarget(await request.json().catch(() => null));
    if (!target) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId!;
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required to delete audio.' }, { status: 503 });
    }
    const client = getComputeWorkerClient();
    const signal = AbortSignal.timeout(50_000);
    const report = await client.getUserStorageUsage({
      storageUserId: userId,
      includePlayback: true,
      derivedDocumentIds: [],
      namespace: null,
    }, { signal });
    const candidates = target === 'orphaned'
      ? orphanedAudioDocumentIds(report, await listOwnedDocumentIds(userId))
      : report.documents.map((row) => row.documentId);
    let batch = candidates.slice(0, LIBRARY_RECLAIM_DOCUMENT_BATCH);
    if (target === 'orphaned') {
      const restored = await filterOwnedDocumentIds(userId, batch);
      batch = batch.filter((documentId) => !restored.has(documentId));
    }

    let deletedObjects = 0;
    for (const documentId of batch) {
      const result = await client.reclaimTtsPlaybackCache({
        storageUserId: userId,
        documentId,
        keep: null,
      }, { signal });
      deletedObjects += result.deletedAudioObjects + result.deletedSidecarObjects + result.deletedExportObjects;
    }

    return NextResponse.json({
      reclaimedDocuments: batch.length,
      remainingDocuments: Math.max(0, candidates.length - LIBRARY_RECLAIM_DOCUMENT_BATCH),
      deletedObjects,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.storage.library_reclaim_failed',
      msg: 'Failed to reclaim library audio',
      apiErrorMessage: 'Failed to delete audio',
      normalize: { code: 'TTS_STORAGE_RECLAIM_FAILED', errorClass: 'storage' },
    });
  }
}
