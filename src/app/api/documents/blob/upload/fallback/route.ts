import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId, putDocumentBlob } from '@/lib/server/documents/blobstore';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export const dynamic = 'force-dynamic';

function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.$metadata?.httpStatusCode === 412 || maybe.name === 'PreconditionFailed';
}

export async function PUT(req: NextRequest) {
  try {
    if (!isS3Configured()) {
      return NextResponse.json(
        { error: 'Documents storage is not configured. Set S3_* environment variables.' },
        { status: 503 },
      );
    }

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const url = new URL(req.url);
    const id = (url.searchParams.get('id') || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    const contentType = (req.headers.get('content-type') || 'application/octet-stream').trim() || 'application/octet-stream';
    const body = Buffer.from(await req.arrayBuffer());
    const namespace = getOpenReaderTestNamespace(req.headers);

    try {
      await putDocumentBlob(id, body, contentType, namespace);
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
    }

    console.info('[blob-fallback] upload proxy used', {
      id,
      contentType,
      bytes: body.byteLength,
    });

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error('Error proxy-uploading document blob:', error);
    return NextResponse.json({ error: 'Failed to upload document blob' }, { status: 500 });
  }
}
