import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { fetchWorkerOperationState } from '@/lib/server/compute/worker-op-state';
import {
  getParsedDocumentBlob,
  getParsedDocumentBlobByKey,
  isMissingBlobError,
  isValidDocumentId,
} from '@/lib/server/documents/blobstore';
import { enqueueParsePdfJob } from '@/lib/server/jobs/user-pdf-layout-job';
import {
  normalizeParseStatus,
  parseDocumentParseState,
  stringifyDocumentParseState,
} from '@/lib/server/documents/parse-state';
import { healStaleDocumentParseState } from '@/lib/server/documents/parse-state-healing';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';

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

function mapWorkerStatusToParseStatus(status: WorkerOperationState['status']) {
  switch (status) {
    case 'queued':
      return 'pending' as const;
    case 'running':
      return 'running' as const;
    case 'succeeded':
      return 'ready' as const;
    case 'failed':
      return 'failed' as const;
    default:
      return 'pending' as const;
  }
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
        parseState: documents.parseState,
        parsedJsonKey: documents.parsedJsonKey,
      })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
      parseState: string | null;
      parsedJsonKey: string | null;
    }>;

    const row = rows.find((candidate) => candidate.userId === storageUserId) ?? rows[0];
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let state = parseDocumentParseState(row.parseState);
    state = await healStaleDocumentParseState({
      documentId: id,
      userId: row.userId,
      state,
    });
    let effectiveStatus = normalizeParseStatus(state.status);
    let effectiveProgress = state.progress ?? null;
    const opId = typeof state.opId === 'string' ? state.opId.trim() : '';
    if (opId && effectiveStatus !== 'ready') {
      const workerState = await fetchWorkerOperationState<PdfLayoutJobResult>(opId);
      if (workerState && workerState.opId === opId) {
        const workerStatus = mapWorkerStatusToParseStatus(workerState.status);
        // Keep DB/blob as source of truth for "ready"; prefer worker only for active/failed states.
        if (workerStatus === 'pending' || workerStatus === 'running' || workerStatus === 'failed') {
          effectiveStatus = workerStatus;
          effectiveProgress = workerStatus === 'running' ? (workerState.progress ?? null) : null;
        }
      }
    }

    if (effectiveStatus === 'failed' && retryFailed) {
      await db
        .update(documents)
        .set({
          parseState: stringifyDocumentParseState({
            status: 'pending',
            progress: null,
            updatedAt: Date.now(),
          }),
        })
        .where(and(eq(documents.id, id), eq(documents.userId, row.userId)));
      enqueueParsePdfJob({
        documentId: id,
        userId: row.userId,
        namespace: testNamespace,
      });
      return NextResponse.json({ parseStatus: 'pending', parseProgress: null }, { status: 202 });
    }

    if (effectiveStatus !== 'ready') {
      return NextResponse.json({
        parseStatus: effectiveStatus,
        parseProgress: effectiveProgress,
      }, { status: 202 });
    }

    try {
      const json = row.parsedJsonKey?.trim()
        ? await getParsedDocumentBlobByKey(row.parsedJsonKey)
        : await getParsedDocumentBlob(id, testNamespace);
      let parsedDoc: ParsedPdfDocument | null = null;
      try {
        parsedDoc = JSON.parse(Buffer.from(json).toString('utf8')) as ParsedPdfDocument;
      } catch {
        parsedDoc = null;
      }

      if (!hasAnyParsedBlocks(parsedDoc)) {
        console.warn('[documents/parsed] parsed doc has no blocks', {
          documentId: id,
          userId: row.userId,
          parsedJsonKey: row.parsedJsonKey,
        });
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
        parseState: documents.parseState,
        parsedJsonKey: documents.parsedJsonKey,
      })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
      parseState: string | null;
      parsedJsonKey: string | null;
    }>;

    const row = rows.find((candidate) => candidate.userId === storageUserId) ?? rows[0];
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let state = parseDocumentParseState(row.parseState);
    state = await healStaleDocumentParseState({
      documentId: id,
      userId: row.userId,
      state,
    });
    let effectiveStatus = normalizeParseStatus(state.status);
    let effectiveProgress = state.progress ?? null;
    const opId = typeof state.opId === 'string' ? state.opId.trim() : '';
    if (opId && effectiveStatus !== 'ready') {
      const workerState = await fetchWorkerOperationState<PdfLayoutJobResult>(opId);
      if (workerState && workerState.opId === opId) {
        const workerStatus = mapWorkerStatusToParseStatus(workerState.status);
        if (workerStatus === 'pending' || workerStatus === 'running' || workerStatus === 'failed') {
          effectiveStatus = workerStatus;
          effectiveProgress = workerStatus === 'running' ? (workerState.progress ?? null) : null;
        }
      }
    }

    if (effectiveStatus !== 'running') {
      await db
        .update(documents)
        .set({
          parseState: stringifyDocumentParseState({
            status: 'pending',
            progress: null,
            updatedAt: Date.now(),
          }),
        })
        .where(and(eq(documents.id, id), eq(documents.userId, row.userId)));
    }

    enqueueParsePdfJob({
      documentId: id,
      userId: row.userId,
      namespace: testNamespace,
      forceToken: randomUUID(),
    });

    return NextResponse.json(
      {
        parseStatus: effectiveStatus === 'running' ? 'running' : 'pending',
        parseProgress: effectiveStatus === 'running' ? effectiveProgress : null,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error('Error forcing parsed PDF refresh:', error);
    return NextResponse.json({ error: 'Failed to force parsed PDF refresh' }, { status: 500 });
  }
}
