import { NextRequest, NextResponse } from 'next/server';
import { presignDocumentPreviewGet } from '@/lib/server/documents/previews-blobstore';
import { ensureDocumentPreview } from '@/lib/server/documents/previews';
import { validatePreviewRequest } from '../utils';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const validation = await validatePreviewRequest(req);
    if (validation.errorResponse) return validation.errorResponse;
    const { doc, testNamespace, id } = validation;

    const presignUrl = `/api/documents/blob/preview/presign?id=${encodeURIComponent(id)}`;
    const preview = await ensureDocumentPreview(
      {
        id: doc.id,
        type: doc.type,
        lastModified: Number(doc.lastModified),
      },
      testNamespace,
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

    const directUrl = await presignDocumentPreviewGet(doc.id, testNamespace);
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
