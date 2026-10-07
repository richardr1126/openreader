import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { UserStorageUsageReport } from '@/lib/server/compute-worker/protocol';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { listOwnedDocumentIds } from '@/lib/server/tts/storage-scope';
import {
  DERIVED_DOCUMENT_BATCH,
  LIBRARY_DERIVED_DOCUMENT_LIMIT,
  summarizeLibraryStorage,
} from '@/lib/server/tts/storage-usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Library-wide storage totals for the signed-in user. */
export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/storage', request });
  try {
    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId!;
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required to measure storage.' }, { status: 503 });
    }
    const owned = await listOwnedDocumentIds(userId);
    const derivedIds = [...owned].sort().slice(0, LIBRARY_DERIVED_DOCUMENT_LIMIT);
    const client = getComputeWorkerClient();
    const signal = AbortSignal.timeout(50_000);
    const reports: UserStorageUsageReport[] = [];
    // The first request also scans the user's playback prefixes; later ones
    // only add derived artifacts for the next batch of owned documents.
    for (let index = 0; index === 0 || index < derivedIds.length; index += DERIVED_DOCUMENT_BATCH) {
      reports.push(await client.getUserStorageUsage({
        storageUserId: userId,
        includePlayback: index === 0,
        derivedDocumentIds: derivedIds.slice(index, index + DERIVED_DOCUMENT_BATCH),
        namespace: null,
      }, { signal }));
    }
    return NextResponse.json({
      ...summarizeLibraryStorage(reports, owned, { derivedTruncated: owned.size > derivedIds.length }),
      documentCount: owned.size,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.storage.library_usage_failed',
      msg: 'Failed to measure library storage',
      apiErrorMessage: 'Failed to measure library storage',
      normalize: { code: 'TTS_STORAGE_USAGE_FAILED', errorClass: 'storage' },
    });
  }
}
