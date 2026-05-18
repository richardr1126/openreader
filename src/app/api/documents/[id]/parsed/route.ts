import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getParsedDocumentBlob, isMissingBlobError, isValidDocumentId } from '@/lib/server/documents/blobstore';
import { enqueueParsePdfJob } from '@/lib/server/jobs/parsePdfJob';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

export const dynamic = 'force-dynamic';

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function hasAnyParsedBlocks(doc: ParsedPdfDocument | null): boolean {
  if (!doc || !Array.isArray(doc.pages)) return false;
  return doc.pages.some((page) => Array.isArray(page.blocks) && page.blocks.length > 0);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const authCtxOrRes = await requireAuthContext(req);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;

    const params = await ctx.params;
    const id = (params.id || '').trim().toLowerCase();
    const retryFailed = req.nextUrl.searchParams.get('retry') === '1';
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = authCtxOrRes.userId ?? unclaimedUserId;
    const allowedUserIds = authCtxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

    const rows = (await db
      .select({
        id: documents.id,
        userId: documents.userId,
        parseStatus: documents.parseStatus,
      })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
      parseStatus: 'pending' | 'running' | 'ready' | 'failed' | 'unsupported' | null;
    }>;

    const row = rows.find((candidate) => candidate.userId === storageUserId) ?? rows[0];
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (row.parseStatus === 'failed' && retryFailed) {
      await db
        .update(documents)
        .set({ parseStatus: 'pending' })
        .where(and(eq(documents.id, id), eq(documents.userId, row.userId)));
      enqueueParsePdfJob({
        documentId: id,
        userId: row.userId,
        namespace: testNamespace,
      });
      return NextResponse.json({ parseStatus: 'pending' }, { status: 202 });
    }

    if (row.parseStatus !== 'ready') {
      if (row.parseStatus === 'pending' || row.parseStatus === 'running' || row.parseStatus === null) {
        enqueueParsePdfJob({
          documentId: id,
          userId: row.userId,
          namespace: testNamespace,
        });
      }
      return NextResponse.json({ parseStatus: row.parseStatus ?? 'pending' }, { status: 202 });
    }

    try {
      const json = await getParsedDocumentBlob(id, testNamespace);
      let parsedDoc: ParsedPdfDocument | null = null;
      try {
        parsedDoc = JSON.parse(Buffer.from(json).toString('utf8')) as ParsedPdfDocument;
      } catch {
        parsedDoc = null;
      }

      if (!hasAnyParsedBlocks(parsedDoc)) {
        await db
          .update(documents)
          .set({ parseStatus: 'pending' })
          .where(and(eq(documents.id, id), eq(documents.userId, row.userId)));
        enqueueParsePdfJob({
          documentId: id,
          userId: row.userId,
          namespace: testNamespace,
        });
        return NextResponse.json({ parseStatus: 'pending' }, { status: 202 });
      }

      return new NextResponse(new Uint8Array(json), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      if (isMissingBlobError(error)) {
        return NextResponse.json({ parseStatus: 'failed', error: 'Parsed document not found' }, { status: 404 });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error reading parsed PDF:', error);
    return NextResponse.json({ error: 'Failed to read parsed PDF' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const authCtxOrRes = await requireAuthContext(req);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;

    const params = await ctx.params;
    const id = (params.id || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = authCtxOrRes.userId ?? unclaimedUserId;
    const allowedUserIds = authCtxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

    const rows = (await db
      .select({
        id: documents.id,
        userId: documents.userId,
        parseStatus: documents.parseStatus,
      })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
      parseStatus: 'pending' | 'running' | 'ready' | 'failed' | 'unsupported' | null;
    }>;

    const row = rows.find((candidate) => candidate.userId === storageUserId) ?? rows[0];
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (row.parseStatus !== 'running') {
      await db
        .update(documents)
        .set({ parseStatus: 'pending' })
        .where(and(eq(documents.id, id), eq(documents.userId, row.userId)));
    }

    enqueueParsePdfJob({
      documentId: id,
      userId: row.userId,
      namespace: testNamespace,
    });

    return NextResponse.json(
      { parseStatus: row.parseStatus === 'running' ? 'running' : 'pending' },
      { status: 202 },
    );
  } catch (error) {
    console.error('Error forcing parsed PDF refresh:', error);
    return NextResponse.json({ error: 'Failed to force parsed PDF refresh' }, { status: 500 });
  }
}
