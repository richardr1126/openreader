import { NextRequest, NextResponse } from 'next/server';
import { presignDocumentPreviewGet } from '@/lib/server/documents/previews-blobstore';
import { ensureDocumentPreview } from '@/lib/server/documents/previews';
import { validatePreviewRequest } from '../utils';
import { errorResponse } from '@/lib/server/errors/next-response';
import { getBrowserStorageTransport } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    if (getBrowserStorageTransport() !== 'presigned') {
      return NextResponse.json({ error: 'Presigned preview delivery is disabled when S3_BROWSER_TRANSPORT=proxy.' }, { status: 409 });
    }
    const validation = await validatePreviewRequest(req);
    if (validation.errorResponse) return validation.errorResponse;
    const { doc, testNamespace } = validation;

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
        },
        {
          status: 202,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    const directUrl = await presignDocumentPreviewGet(doc.id, testNamespace);

    return NextResponse.redirect(directUrl, {
      status: 307,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to prepare document preview',
      normalize: { code: 'DOCUMENTS_PREVIEW_PRESIGN_FAILED', errorClass: 'storage' },
    });
  }
}
