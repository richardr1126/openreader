import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextRequest, NextResponse } from 'next/server';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { getS3Client, getS3Config, isS3Configured } from '@/lib/server/storage/s3';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

export const dynamic = 'force-dynamic';

function cleanDispositionFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_');
}

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

    const cfg = getS3Config();
    const signedUrl = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: artifact.objectKey,
        ResponseContentType: artifact.contentType,
        ResponseContentDisposition: `attachment; filename="${cleanDispositionFilename(artifact.dispositionFilename)}"`,
      }),
      { expiresIn: 5 * 60 },
    );
    return NextResponse.redirect(signedUrl, { status: 303 });
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
