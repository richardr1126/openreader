import { NextRequest } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { resolveAudiobookCaller } from '@/lib/server/audiobooks/request';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { sendStorageArtifact } from '@/lib/server/storage/artifact-download';
import { isS3Configured } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; artifactId: string }> }) {
  const { logger } = createRequestLogger({ route: '/api/v1/documents/[id]/audiobooks/files/[artifactId]', request });
  try {
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for audiobooks.');
    }
    if (!isS3Configured()) {
      return apiErrorResponse(503, 'OBJECT_STORAGE_REQUIRED', 'Object storage is required for audiobooks.');
    }
    const { id, artifactId } = await context.params;
    const documentId = id.trim().toLowerCase();
    if (!/^[a-f0-9]{8,128}$/i.test(artifactId)) {
      return apiErrorResponse(400, 'REQUEST_INVALID', 'Invalid audiobook file reference.');
    }

    // Authorize the document scope before touching worker state; the artifact
    // key is user/document-scoped, so the read cannot cross ownership.
    const caller = await resolveAudiobookCaller(request, documentId, 'documents:read');
    if (caller instanceof Response) return caller;
    const { storageUserId } = caller.scope;

    const artifact = await new ComputeWorkerClient().getTtsPlaybackExportArtifact({
      artifactId,
      storageUserId,
      documentId,
    });
    if (!artifact || artifact.storageUserId !== storageUserId) {
      return apiErrorResponse(404, 'AUDIOBOOK_FILE_NOT_READY', 'This audiobook file is not ready.');
    }

    return await sendStorageArtifact({
      objectKey: artifact.objectKey,
      contentType: artifact.contentType,
      dispositionFilename: artifact.dispositionFilename,
    });
  } catch (error) {
    return apiCatchResponse(error, {
      logger,
      event: 'audiobooks.file_failed',
      msg: 'Failed to authorize the audiobook download',
      normalize: { code: 'AUDIOBOOK_FILE_FAILED', errorClass: 'unknown' },
    });
  }
}
