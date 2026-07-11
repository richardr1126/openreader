import { NextRequest, NextResponse } from 'next/server';
import { ensureDocumentPreview } from '@/lib/server/documents/previews';
import { getDocumentPreviewBuffer } from '@/lib/server/documents/previews-blobstore';
import { getBrowserStorageTransport } from '@/lib/server/storage/s3';
import { validatePreviewRequest } from './utils';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    if (getBrowserStorageTransport() !== 'proxy') return NextResponse.json({ error: 'Proxy preview delivery is disabled when S3_BROWSER_TRANSPORT=presigned.' }, { status: 409 });
    const validation = await validatePreviewRequest(req);
    if (validation.errorResponse) return validation.errorResponse;
    const preview = await ensureDocumentPreview({ id: validation.doc.id, type: validation.doc.type, lastModified: Number(validation.doc.lastModified) }, validation.testNamespace);
    if (preview.state !== 'ready') return NextResponse.json({ status: preview.status, opId: preview.opId }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    const body = await getDocumentPreviewBuffer(validation.doc.id, validation.testNamespace);
    return new NextResponse(body as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.byteLength), 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error, { apiErrorMessage: 'Failed to deliver document preview', normalize: { code: 'DOCUMENTS_PREVIEW_GET_FAILED', errorClass: 'storage' } });
  }
}
