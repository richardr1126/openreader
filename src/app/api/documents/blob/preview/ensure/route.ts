import { NextRequest, NextResponse } from 'next/server';
import { presignDocumentPreviewGet } from '@/lib/server/documents/previews-blobstore';
import { ensureDocumentPreview } from '@/lib/server/documents/previews';
import { validatePreviewRequest } from '../utils';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const validation = await validatePreviewRequest(req);
    if (validation.errorResponse) return validation.errorResponse;
    const { doc, testNamespace, id } = validation;

    const presignUrl = `/api/documents/blob/preview/presign?id=${encodeURIComponent(id)}`;
    const fallbackUrl = `/api/documents/blob/preview/fallback?id=${encodeURIComponent(id)}`;
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
          retryAfterMs: preview.retryAfterMs,
          presignUrl,
          fallbackUrl,
        },
        {
          status: 202,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    const directUrl = await presignDocumentPreviewGet(doc.id, testNamespace).catch(() => null);
    return NextResponse.json(
      {
        status: 'ready',
        presignUrl,
        fallbackUrl,
        ...(directUrl ? { directUrl } : {}),
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    serverLogger.error({
      event: 'documents.preview.ensure.failed',
      error: errorToLog(error),
    }, 'Failed to ensure document preview');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to ensure document preview',
      normalize: { code: 'DOCUMENTS_PREVIEW_ENSURE_FAILED', errorClass: 'storage' },
    });
  }
}
