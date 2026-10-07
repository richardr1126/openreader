import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { resolveDocumentStorageScope } from '@/lib/server/tts/storage-scope';
import { summarizeDocumentStorage } from '@/lib/server/tts/storage-usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Storage used by one document, split by the reader's current cache identity. */
export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/storage/document', request });
  try {
    const resolved = await resolveDocumentStorageScope(request);
    if (resolved instanceof Response) return resolved;
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required to measure storage.' }, { status: 503 });
    }
    const report = await getComputeWorkerClient().getUserStorageUsage({
      storageUserId: resolved.scope.storageUserId,
      includePlayback: true,
      documentId: resolved.documentId,
      derivedDocumentIds: [resolved.documentId],
      namespace: null,
    }, { signal: AbortSignal.timeout(45_000) });
    return NextResponse.json(summarizeDocumentStorage(report, {
      documentId: resolved.documentId,
      documentVersion: resolved.scope.documentVersion,
      settingsHash: resolved.settingsHash,
    }));
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.storage.document_usage_failed',
      msg: 'Failed to measure document storage',
      apiErrorMessage: 'Failed to measure document storage',
      normalize: { code: 'TTS_STORAGE_USAGE_FAILED', errorClass: 'storage' },
    });
  }
}
