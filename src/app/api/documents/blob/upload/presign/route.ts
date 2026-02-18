import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId, presignPut } from '@/lib/server/documents/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';

type PresignUpload = {
  id: string;
  contentType: string;
  size: number;
};

function parseUploads(body: unknown): PresignUpload[] {
  if (!body || typeof body !== 'object') return [];
  const rawUploads = (body as { uploads?: unknown }).uploads;
  if (!Array.isArray(rawUploads)) return [];

  const uploads: PresignUpload[] = [];
  for (const raw of rawUploads) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim().toLowerCase() : '';
    if (!isValidDocumentId(id)) continue;
    const contentType =
      typeof rec.contentType === 'string' && rec.contentType.trim()
        ? rec.contentType.trim()
        : 'application/octet-stream';
    const size = Number.isFinite(rec.size) && Number(rec.size) >= 0 ? Number(rec.size) : 0;
    uploads.push({ id, contentType, size });
  }
  return uploads;
}

export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) {
      return NextResponse.json(
        { error: 'Documents storage is not configured. Set S3_* environment variables.' },
        { status: 503 },
      );
    }

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const body = await req.json().catch(() => null);
    const uploads = parseUploads(body);
    if (uploads.length === 0) {
      return NextResponse.json({ error: 'No valid uploads provided' }, { status: 400 });
    }

    const namespace = getOpenReaderTestNamespace(req.headers);
    const signed = await Promise.all(
      uploads.map(async (upload) => {
        const res = await presignPut(upload.id, upload.contentType, namespace);
        return {
          id: upload.id,
          url: res.url,
          headers: res.headers,
        };
      }),
    );

    return NextResponse.json({ uploads: signed });
  } catch (error) {
    console.error('Error creating document upload signatures:', error);
    return NextResponse.json({ error: 'Failed to presign uploads' }, { status: 500 });
  }
}

