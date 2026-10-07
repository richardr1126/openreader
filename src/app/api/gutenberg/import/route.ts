import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { putTempDocumentBlob } from '@/lib/server/documents/blobstore';
import { downloadGutenbergEpub } from '@/lib/server/documents/gutenberg';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { isS3Configured } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';
// A large illustrated EPUB from gutenberg.org can take most of a minute.
export const maxDuration = 300;

/**
 * Downloads one book into the caller's temp upload area and returns the token.
 * The client finalizes it through `/api/documents/blob/upload/finalize`, so a
 * catalog import becomes a document exactly the way a file upload does. Only
 * the catalog ID is accepted; the download URL comes from the catalog, never
 * from the request.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) {
      return NextResponse.json({ error: 'Documents storage is not configured. Set S3_* environment variables.' }, { status: 503 });
    }
    const auth = await requireAuthContext(req);
    if (auth instanceof Response) return auth;
    const userId = auth.userId;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null) as { id?: unknown } | null;
    const id = body?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      return NextResponse.json({ error: 'Missing or invalid book id' }, { status: 400 });
    }

    const { maxUploadMb } = await getResolvedRuntimeConfig();
    const { book, name, bytes } = await downloadGutenbergEpub(id, maxUploadMb * 1024 * 1024);
    const token = randomUUID();
    await putTempDocumentBlob(token, userId, bytes, 'application/epub+zip', null);

    return NextResponse.json({
      token,
      name,
      type: 'epub',
      lastModified: Date.now(),
      title: book.title,
      // Import hints the client forwards to finalize; the catalog is more
      // reliable than whatever the EPUB package declares.
      author: book.authors.slice(0, 3).join(', ') || null,
      language: book.languages[0] ?? null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'gutenberg.import.failed',
      msg: 'Failed to import a Project Gutenberg book',
      normalize: { code: 'GUTENBERG_IMPORT_FAILED', errorClass: 'upstream' },
    });
  }
}
