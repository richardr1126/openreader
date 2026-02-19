import { NextRequest, NextResponse } from 'next/server';
import { presignDocumentPreviewGet } from '@/lib/server/documents/previews-blobstore';
import { ensureDocumentPreview } from '@/lib/server/documents/previews';
import { validatePreviewRequest } from '../utils';

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
      console.warn('[blob-fallback] presign preview unavailable, redirecting to proxy fallback', { id: doc.id });
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
    console.error('Error creating document preview signature:', error);
    return NextResponse.json({ error: 'Failed to prepare document preview' }, { status: 500 });
  }
}
