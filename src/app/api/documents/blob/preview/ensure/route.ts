import { NextRequest, NextResponse } from 'next/server';
import { presignDocumentPreviewGet } from '@/lib/server/documents/previews-blobstore';
import { ensureDocumentPreview } from '@/lib/server/documents/previews';
import { validatePreviewRequest } from '../utils';
import { errorResponse } from '@/lib/server/errors/next-response';
import { getBrowserStorageTransport } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const validation = await validatePreviewRequest(req);
    if (validation.errorResponse) return validation.errorResponse;
    const { doc, id } = validation;

    const presignUrl = getBrowserStorageTransport() === 'proxy'
      ? `/api/documents/blob/preview?id=${encodeURIComponent(id)}`
      : `/api/documents/blob/preview/presign?id=${encodeURIComponent(id)}`;
    const preview = await ensureDocumentPreview(
      {
        id: doc.id,
        userId: doc.userId,
        type: doc.type,
        lastModified: Number(doc.lastModified),
      },
      null,
    );

    if (preview.state !== 'ready') {
      return NextResponse.json(
        {
          status: preview.status,
          opId: preview.opId,
          presignUrl,
        },
        {
          status: 202,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    const directUrl = getBrowserStorageTransport() === 'presigned'
      // Longer-lived so the client can render the image straight from S3 and
      // reuse the same URL across remounts/scroll-back for most of a session,
      // instead of re-hitting the presign route on every image load.
      ? await presignDocumentPreviewGet(doc.id, null, { expiresInSeconds: 3600 })
      : undefined;
    return NextResponse.json(
      {
        status: 'ready',
        presignUrl,
        previewVersion: preview.eTag || String(doc.lastModified),
        directUrl,
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to ensure document preview',
      normalize: { code: 'DOCUMENTS_PREVIEW_ENSURE_FAILED', errorClass: 'storage' },
    });
  }
}
