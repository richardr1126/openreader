import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { putTempDocumentBlob, isValidTempUploadToken, presignTempPut } from '@/lib/server/documents/blobstore';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getBrowserStorageTransport, isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { errorResponse } from '@/lib/server/errors/next-response';

type UploadRequest = { contentType: string; size: number };

function parseUploads(body: unknown): UploadRequest[] {
  const raw = body && typeof body === 'object' ? (body as { uploads?: unknown }).uploads : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const rec = item as Record<string, unknown>;
    return [{
      contentType: typeof rec.contentType === 'string' && rec.contentType.trim() ? rec.contentType.trim() : 'application/octet-stream',
      size: Number.isFinite(rec.size) && Number(rec.size) >= 0 ? Number(rec.size) : 0,
    }];
  });
}

function storageUnavailable(): NextResponse {
  return NextResponse.json({ error: 'Documents storage is not configured. Set S3_* environment variables.' }, { status: 503 });
}

async function authorize(req: NextRequest) {
  const auth = await requireAuthContext(req);
  if (auth instanceof Response) return auth;
  if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return auth;
}

/** Prepare one deterministic browser transfer. The returned URL is either a
 * public signature or this same-origin route; callers never retry another mode. */
export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) return storageUnavailable();
    const auth = await authorize(req);
    if (auth instanceof Response) return auth;
    const userId = auth.userId;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const transport = getBrowserStorageTransport();
    const namespace = getOpenReaderTestNamespace(req.headers);

    if (!req.headers.get('content-type')?.includes('application/json')) {
      return NextResponse.json({ error: 'Upload preparation requires application/json.' }, { status: 400 });
    }
    const uploads = parseUploads(await req.json().catch(() => null));
    if (uploads.length === 0) return NextResponse.json({ error: 'No valid uploads provided' }, { status: 400 });
    const { maxUploadMb } = await getResolvedRuntimeConfig();
    const maxBytes = maxUploadMb * 1024 * 1024;
    if (uploads.some((upload) => upload.size > maxBytes)) return NextResponse.json({ error: `Upload exceeds the maximum allowed size of ${maxBytes} bytes`, maxBytes }, { status: 413 });

    const prepared = await Promise.all(uploads.map(async (upload) => {
      const uploadToken = randomUUID();
      if (transport === 'proxy') {
        return {
          token: uploadToken,
          url: `/api/documents/blob/upload?token=${encodeURIComponent(uploadToken)}`,
          headers: { 'Content-Type': upload.contentType },
        };
      }
      const signed = await presignTempPut(uploadToken, userId, upload.contentType, namespace, { contentLength: upload.size });
      return { token: uploadToken, url: signed.url, headers: signed.headers };
    }));
    return NextResponse.json({ transport, uploads: prepared }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to prepare document upload',
      normalize: { code: 'DOCUMENTS_BLOB_UPLOAD_FAILED', errorClass: 'storage' },
    });
  }
}

/** Store bytes for a same-origin proxy transfer prepared by POST. Presigned
 * transfers use the same PUT method directly against object storage. */
export async function PUT(req: NextRequest) {
  try {
    if (!isS3Configured()) return storageUnavailable();
    const auth = await authorize(req);
    if (auth instanceof Response) return auth;
    const userId = auth.userId;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (getBrowserStorageTransport() !== 'proxy') {
      return NextResponse.json({ error: 'Proxy upload is disabled when S3_BROWSER_TRANSPORT=presigned.' }, { status: 409 });
    }

    const token = req.nextUrl.searchParams.get('token')?.trim().toLowerCase() ?? '';
    if (!isValidTempUploadToken(token)) {
      return NextResponse.json({ error: 'Invalid upload token' }, { status: 400 });
    }

    const { maxUploadMb } = await getResolvedRuntimeConfig();
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.byteLength > maxUploadMb * 1024 * 1024) {
      return NextResponse.json({ error: 'Upload exceeds the configured maximum size' }, { status: 413 });
    }

    const contentType = req.headers.get('content-type') || 'application/octet-stream';
    const namespace = getOpenReaderTestNamespace(req.headers);
    await putTempDocumentBlob(token, userId, bytes, contentType, namespace);
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to upload document',
      normalize: { code: 'DOCUMENTS_BLOB_UPLOAD_FAILED', errorClass: 'storage' },
    });
  }
}
