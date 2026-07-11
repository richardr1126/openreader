import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { resolveCurrentPdfParse } from '@/lib/server/pdf-parse/operation';
import { getS3Client, getS3Config, isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/parsed/download',
    request,
  });
  try {
    if (!isS3Configured()) {
      return NextResponse.json({ error: 'Documents storage is not configured. Set S3_* environment variables.' }, { status: 503 });
    }
    const authCtxOrRes = await requireAuthContext(request);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;
    if (!authCtxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: rawId } = await ctx.params;
    const id = rawId.trim().toLowerCase();
    if (!isValidDocumentId(id)) return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });

    const rows = await db
      .select({ id: documents.id, type: documents.type })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, [authCtxOrRes.userId])))
      .limit(1);
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (rows[0].type !== 'pdf') return NextResponse.json({ error: 'Document is not a PDF' }, { status: 400 });

    const resolved = await resolveCurrentPdfParse({
      documentId: id,
      namespace: getOpenReaderTestNamespace(request.headers),
    });
    if (!resolved.artifact) return NextResponse.json({ error: 'Parsed PDF is not ready' }, { status: 404 });

    const cfg = getS3Config();
    const signedUrl = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: resolved.artifact.objectKey,
        ResponseContentType: 'application/json',
      }),
      { expiresIn: 5 * 60 },
    );
    return NextResponse.redirect(signedUrl, { status: 303 });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'documents.parsed.download_failed',
      msg: 'Failed to authorize parsed PDF delivery',
      apiErrorMessage: 'Failed to prepare parsed PDF delivery',
      normalize: { code: 'DOCUMENTS_PARSED_DOWNLOAD_FAILED', errorClass: 'unknown' },
    });
  }
}
