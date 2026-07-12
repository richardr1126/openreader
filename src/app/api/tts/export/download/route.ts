import { NextRequest, NextResponse } from 'next/server';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { sendStorageArtifact } from '@/lib/server/storage/artifact-download';
import { isS3Configured } from '@/lib/server/storage/s3';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/export/download',
    request,
  });

  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required for audiobook export.' }, { status: 503 });
    }
    if (!isS3Configured()) {
      return NextResponse.json({ error: 'Object storage is required for audiobook export.' }, { status: 503 });
    }

    const artifactId = request.nextUrl.searchParams.get('artifactId')?.trim() ?? '';
    if (!/^[a-f0-9]{8,128}$/i.test(artifactId)) {
      return NextResponse.json({ error: 'Invalid audiobook export artifact reference' }, { status: 400 });
    }

    const artifact = await new ComputeWorkerClient().getTtsPlaybackExportArtifact(artifactId);
    if (!artifact) {
      return NextResponse.json({ error: 'Audiobook export artifact is not ready' }, { status: 404 });
    }

    const scope = await resolveSegmentDocumentScope(request, artifact.documentId);
    if (scope instanceof Response) return scope;
    if (scope.storageUserId !== artifact.storageUserId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return await sendStorageArtifact({
      objectKey: artifact.objectKey,
      contentType: artifact.contentType,
      dispositionFilename: artifact.dispositionFilename,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.export.download_failed',
      msg: 'Failed to authorize audiobook export download',
      apiErrorMessage: 'Failed to authorize audiobook export download',
      normalize: { code: 'TTS_EXPORT_DOWNLOAD_FAILED', errorClass: 'unknown' },
    });
  }
}
