import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { getBrowserStorageTransport, getS3Client, getS3Config, getS3InternalClient, isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { ACCOUNT_EXPORT_SCHEMA_VERSION } from '@/lib/server/user/data-export';

export const dynamic = 'force-dynamic';

function cleanDispositionFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_');
}

export async function GET(req: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/user/export/download',
    request: req,
  });

  try {
    if (!auth) {
      return errorResponse(new Error('Auth not initialized'), {
        apiErrorMessage: 'Auth not initialized',
        normalize: { code: 'USER_EXPORT_AUTH_NOT_INITIALIZED', errorClass: 'auth', httpStatus: 500 },
      });
    }
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for account export.' },
        { status: 503 },
      );
    }
    if (!isS3Configured()) {
      return NextResponse.json(
        { error: 'Object storage is required for account export.' },
        { status: 503 },
      );
    }

    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const artifactId = req.nextUrl.searchParams.get('artifactId')?.trim() ?? '';
    const manifestHash = req.nextUrl.searchParams.get('manifestHash')?.trim() ?? '';
    if (!/^[a-f0-9]{8,128}$/i.test(artifactId) || !/^[a-f0-9]{64}$/i.test(manifestHash)) {
      return NextResponse.json({ error: 'Invalid account export artifact reference' }, { status: 400 });
    }

    const resolved = await new ComputeWorkerClient().resolveAccountExport({
      artifactId,
      storageUserId: session.user.id,
      namespace: getOpenReaderTestNamespace(req.headers),
      schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
      manifestHash,
    });

    if (!resolved.artifact) {
      return NextResponse.json({ error: 'Account export artifact is not ready' }, { status: 404 });
    }

    const cfg = getS3Config();
    if (getBrowserStorageTransport() === 'proxy') {
      const object = await getS3InternalClient().send(new GetObjectCommand({ Bucket: cfg.bucket, Key: resolved.artifact.objectKey }));
      const bytes = await object.Body?.transformToByteArray();
      return new NextResponse(bytes as unknown as BodyInit, {
        headers: {
          'Content-Type': resolved.artifact.contentType,
          'Content-Disposition': `attachment; filename="${cleanDispositionFilename(resolved.artifact.dispositionFilename)}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }
    const signedUrl = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: resolved.artifact.objectKey,
        ResponseContentType: resolved.artifact.contentType,
        ResponseContentDisposition: `attachment; filename="${cleanDispositionFilename(resolved.artifact.dispositionFilename)}"`,
      }),
      { expiresIn: 5 * 60 },
    );

    return NextResponse.redirect(signedUrl, { status: 303 });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'user.export.download_failed',
      msg: 'Failed to authorize account export download',
      apiErrorMessage: 'Failed to authorize account export download',
      normalize: { code: 'USER_EXPORT_DOWNLOAD_FAILED', errorClass: 'unknown' },
    });
  }
}
