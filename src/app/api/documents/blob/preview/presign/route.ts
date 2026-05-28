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
          fallbackUrl,
        },
        {
          status: 202,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    const directUrl = await presignDocumentPreviewGet(doc.id, testNamespace).catch(() => null);
    if (!directUrl) {
      serverLogger.warn({
        event: 'documents.preview.presign.unavailable',
        degraded: true,
        fallbackPath: 'preview_proxy',
        documentId: doc.id,
      }, 'Presigned document preview unavailable, redirecting to proxy fallback');
      return NextResponse.redirect(fallbackUrl, {
        status: 307,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.redirect(directUrl, {
      status: 307,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    serverLogger.error({
      event: 'documents.preview.presign.failed',
      error: errorToLog(error),
    }, 'Failed to create document preview signature');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to prepare document preview',
      normalize: { code: 'DOCUMENTS_PREVIEW_PRESIGN_FAILED', errorClass: 'storage' },
    });
  }
}
