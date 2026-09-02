import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import { getBrowserStorageTransport, getS3Client, getS3Config, getS3InternalClient } from '@/lib/server/storage/s3';

const DOWNLOAD_URL_EXPIRES_SECONDS = 5 * 60;

export function cleanDispositionFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_');
}

/**
 * Deliver an authorized storage artifact using the deployment's browser
 * transport: same-origin bytes in `proxy` mode, otherwise a 303 redirect to a
 * short-lived presigned URL from the public S3 client. Callers must have
 * already authenticated the user and resolved artifact ownership.
 */
export async function sendStorageArtifact(input: {
  objectKey: string;
  contentType: string;
  dispositionFilename?: string;
}): Promise<NextResponse> {
  const cfg = getS3Config();
  const disposition = input.dispositionFilename === undefined
    ? undefined
    : `attachment; filename="${cleanDispositionFilename(input.dispositionFilename)}"`;

  if (getBrowserStorageTransport() === 'proxy') {
    const object = await getS3InternalClient().send(new GetObjectCommand({ Bucket: cfg.bucket, Key: input.objectKey }));
    const bytes = await object.Body?.transformToByteArray();
    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': input.contentType,
        ...(disposition ? { 'Content-Disposition': disposition } : {}),
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const signedUrl = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: input.objectKey,
      ResponseContentType: input.contentType,
      ...(disposition ? { ResponseContentDisposition: disposition } : {}),
    }),
    { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS },
  );
  return NextResponse.redirect(signedUrl, { status: 303 });
}
