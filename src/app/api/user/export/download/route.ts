import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/server/auth/auth';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { sendStorageArtifact } from '@/lib/server/storage/artifact-download';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { ACCOUNT_EXPORT_SCHEMA_VERSION } from '@/lib/server/user/data-export';

export const dynamic = 'force-dynamic';

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

    return await sendStorageArtifact({
      objectKey: resolved.artifact.objectKey,
      contentType: resolved.artifact.contentType,
      dispositionFilename: resolved.artifact.dispositionFilename,
    });
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
