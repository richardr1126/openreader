import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { createOrReusePdfWorkerOperation } from '@/lib/server/compute/worker-op-create';
import { snapshotFromWorkerState } from '@/lib/server/compute/worker-parse-state';
import { fetchWorkerOperationState } from '@/lib/server/compute/worker-op-state';
import {
  documentKey,
  getParsedDocumentBlob,
  getParsedDocumentBlobByKey,
  isMissingBlobError,
  isValidDocumentId,
  putParsedDocumentBlob,
} from '@/lib/server/documents/blobstore';
import {
  normalizeParseStatus,
  parseDocumentParseState,
  stringifyDocumentParseState,
} from '@/lib/server/documents/parse-state';
import { healStaleDocumentParseState } from '@/lib/server/documents/parse-state-healing';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { checkJobRate, recordJobEvent, getPdfLayoutRateConfig } from '@/lib/server/rate-limit/job-rate-limiter';
import { buildComputeRateLimitedResponse } from '@/lib/server/rate-limit/problem-response';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger, hashForLog, type ServerLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { logDegraded } from '@/lib/server/errors/logging';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';

export const dynamic = 'force-dynamic';

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

type ParseRow = {
  id: string;
  userId: string;
  parseState: string | null;
  parsedJsonKey: string | null;
};

function hasAnyParsedBlocks(doc: ParsedPdfDocument | null): boolean {
  if (!doc || !Array.isArray(doc.pages)) return false;
  return doc.pages.some((page) => Array.isArray(page.blocks) && page.blocks.length > 0);
}

function normalizeOpId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

async function loadRows(input: {
  documentId: string;
  allowedUserIds: string[];
}): Promise<ParseRow[]> {
  return (await db
    .select({
      id: documents.id,
      userId: documents.userId,
      parseState: documents.parseState,
      parsedJsonKey: documents.parsedJsonKey,
    })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), inArray(documents.userId, input.allowedUserIds)))) as ParseRow[];
}

function pickPreferredRow(rows: ParseRow[], storageUserId: string): ParseRow | null {
  return rows.find((candidate) => candidate.userId === storageUserId) ?? rows[0] ?? null;
}

async function writeParseRowState(input: {
  documentId: string;
  userId: string;
  parseState: string;
  parsedJsonKey?: string | null;
}): Promise<void> {
  await db
    .update(documents)
    .set({
      parseState: input.parseState,
      ...(typeof input.parsedJsonKey === 'string' || input.parsedJsonKey === null
        ? { parsedJsonKey: input.parsedJsonKey }
        : {}),
    })
    .where(and(eq(documents.id, input.documentId), eq(documents.userId, input.userId)));
}

async function finalizeFromWorkerState(input: {
  workerState: WorkerOperationState<PdfLayoutJobResult>;
  row: ParseRow;
  namespace: string | null;
  logger: ServerLogger;
}): Promise<NextResponse> {
  const snapshot = snapshotFromWorkerState(input.workerState);

  if (snapshot.parseStatus === 'pending' || snapshot.parseStatus === 'running') {
    return NextResponse.json({
      parseStatus: snapshot.parseStatus,
      parseProgress: snapshot.parseProgress,
      opId: input.workerState.opId,
    }, { status: 202 });
  }

  if (snapshot.parseStatus === 'failed') {
    await writeParseRowState({
      documentId: input.row.id,
      userId: input.row.userId,
      parseState: stringifyDocumentParseState({
        status: 'failed',
        progress: null,
        updatedAt: Date.now(),
        error: input.workerState.error?.message ?? 'Worker parse failed',
      }),
    });

    return NextResponse.json({
      parseStatus: 'failed',
      parseProgress: null,
      opId: input.workerState.opId,
      error: input.workerState.error?.message ?? 'Worker parse failed',
    }, { status: 202 });
  }

  let parsedJsonKey: string | null = null;
  if (input.workerState.result && 'parsedObjectKey' in input.workerState.result) {
    parsedJsonKey = typeof input.workerState.result.parsedObjectKey === 'string'
      ? input.workerState.result.parsedObjectKey
      : null;
  }

  if (!parsedJsonKey && input.workerState.result && 'parsed' in input.workerState.result && input.workerState.result.parsed) {
    const parsedJson = Buffer.from(JSON.stringify(input.workerState.result.parsed));
    parsedJsonKey = await putParsedDocumentBlob(input.row.id, parsedJson, input.namespace);
  }

  if (!parsedJsonKey) {
    return errorResponse(new Error('Worker completed without parsed output'), {
      apiErrorMessage: 'Worker completed without parsed output',
      normalize: { code: 'DOCUMENTS_PARSED_WORKER_OUTPUT_MISSING', errorClass: 'upstream' },
    });
  }

  await writeParseRowState({
    documentId: input.row.id,
    userId: input.row.userId,
    parseState: stringifyDocumentParseState({
      status: 'ready',
      progress: null,
      updatedAt: Date.now(),
    }),
    parsedJsonKey,
  });

  const json = await getParsedDocumentBlobByKey(parsedJsonKey);
  let parsedDoc: ParsedPdfDocument | null = null;
  try {
    parsedDoc = JSON.parse(Buffer.from(json).toString('utf8')) as ParsedPdfDocument;
  } catch {
    parsedDoc = null;
  }

  if (!hasAnyParsedBlocks(parsedDoc)) {
    input.logger.warn({
      event: 'documents.parsed.no_blocks_in_output',
      documentId: input.row.id,
      userIdHash: hashForLog(input.row.userId),
      parsedJsonKey,
    }, 'Worker output parsed successfully but contained no blocks');
  }

  return new NextResponse(new Uint8Array(json), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/parsed',
    request: req,
  });
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const authCtxOrRes = await requireAuthContext(req);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;

    const params = await ctx.params;
    const id = (params.id || '').trim().toLowerCase();
    const retryFailed = req.nextUrl.searchParams.get('retry') === '1';
    const requestedOpId = normalizeOpId(req.nextUrl.searchParams.get('opId'));
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = authCtxOrRes.userId ?? unclaimedUserId;
    const allowedUserIds = authCtxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

    const rows = await loadRows({ documentId: id, allowedUserIds });
    const row = pickPreferredRow(rows, storageUserId);
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (requestedOpId) {
      const workerState = await fetchWorkerOperationState<PdfLayoutJobResult>(requestedOpId);
      if (workerState && workerState.opId === requestedOpId) {
        return finalizeFromWorkerState({
          workerState,
          row,
          namespace: testNamespace,
          logger,
        });
      }
      logDegraded(logger, {
        event: 'documents.parsed.requested_op_unavailable',
        msg: 'Requested worker operation id was unavailable',
        step: 'requested_op_lookup',
        context: {
          documentId: id,
          userIdHash: hashForLog(row.userId),
          opId: requestedOpId,
          error: {
            name: 'RequestedOperationUnavailable',
            message: `Requested worker operation ${requestedOpId} was unavailable`,
          },
        },
      });
    }

    let state = parseDocumentParseState(row.parseState);
    state = await healStaleDocumentParseState({
      documentId: id,
      userId: row.userId,
      state,
    });

    const effectiveStatus = normalizeParseStatus(state.status);
    const effectiveProgress = state.progress ?? null;
    const effectiveOpId = normalizeOpId(state.opId);

    if (effectiveOpId && effectiveStatus !== 'ready') {
      const workerState = await fetchWorkerOperationState<PdfLayoutJobResult>(effectiveOpId);
      if (workerState && workerState.opId === effectiveOpId) {
        return finalizeFromWorkerState({
          workerState,
          row,
          namespace: testNamespace,
          logger,
        });
      }
    }

    if (effectiveStatus === 'failed' && retryFailed) {
      const rateConfig = getPdfLayoutRateConfig(await getResolvedRuntimeConfig());
      const rateDecision = await checkJobRate(authCtxOrRes.userId, 'pdf_layout', rateConfig);
      if (!rateDecision.allowed) {
        return buildComputeRateLimitedResponse({ decision: rateDecision, pathname: req.nextUrl.pathname });
      }
      const created = await createOrReusePdfWorkerOperation({
        documentId: id,
        namespace: testNamespace,
        documentObjectKey: documentKey(id, testNamespace),
      });
      await recordJobEvent(authCtxOrRes.userId, 'pdf_layout', created.opId, rateConfig);
      const snapshot = snapshotFromWorkerState(created);
      return NextResponse.json({
        parseStatus: snapshot.parseStatus,
        parseProgress: snapshot.parseProgress,
        opId: created.opId,
      }, { status: 202 });
    }

    if (effectiveStatus !== 'ready') {
      return NextResponse.json({
        parseStatus: effectiveStatus,
        parseProgress: effectiveProgress,
        opId: effectiveOpId,
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
        logger.warn({
          event: 'documents.parsed.no_blocks_from_blob',
          documentId: id,
          userIdHash: hashForLog(row.userId),
          parsedJsonKey: row.parsedJsonKey,
        }, 'Parsed document blob contained no blocks');
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
    return errorResponse(error, {
      logger,
      event: 'documents.parsed.get_failed',
      msg: 'Failed to read parsed PDF',
      apiErrorMessage: 'Failed to read parsed PDF',
      normalize: { code: 'DOCUMENTS_PARSED_GET_FAILED', errorClass: 'storage' },
    });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/parsed',
    request: req,
  });
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const authCtxOrRes = await requireAuthContext(req);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;

    const params = await ctx.params;
    const id = (params.id || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    let replace = false;
    try {
      const body = (await req.json()) as { replace?: unknown };
      replace = body?.replace === true;
    } catch {
      replace = false;
    }

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = authCtxOrRes.userId ?? unclaimedUserId;
    const allowedUserIds = authCtxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

    const rows = await loadRows({ documentId: id, allowedUserIds });
    const row = pickPreferredRow(rows, storageUserId);
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let state = parseDocumentParseState(row.parseState);
    state = await healStaleDocumentParseState({
      documentId: id,
      userId: row.userId,
      state,
    });

    const existingOpId = normalizeOpId(state.opId);
    if (existingOpId) {
      const existing = await fetchWorkerOperationState<PdfLayoutJobResult>(existingOpId);
      if (existing && (existing.status === 'queued' || existing.status === 'running') && !replace) {
        const snapshot = snapshotFromWorkerState(existing);
        return NextResponse.json({
          error: 'Parse operation already in progress',
          parseStatus: snapshot.parseStatus,
          parseProgress: snapshot.parseProgress,
          opId: existing.opId,
        }, { status: 409 });
      }
    }

    const rateConfig = getPdfLayoutRateConfig(await getResolvedRuntimeConfig());
    const rateDecision = await checkJobRate(authCtxOrRes.userId, 'pdf_layout', rateConfig);
    if (!rateDecision.allowed) {
      return buildComputeRateLimitedResponse({ decision: rateDecision, pathname: req.nextUrl.pathname });
    }

    const created = await createOrReusePdfWorkerOperation({
      documentId: id,
      namespace: testNamespace,
      documentObjectKey: documentKey(id, testNamespace),
      forceToken: randomUUID(),
    });
    await recordJobEvent(authCtxOrRes.userId, 'pdf_layout', created.opId, rateConfig);

    const snapshot = snapshotFromWorkerState(created);

    return NextResponse.json({
      parseStatus: snapshot.parseStatus,
      parseProgress: snapshot.parseProgress,
      opId: created.opId,
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'documents.parsed.force_refresh_failed',
      msg: 'Failed to force PDF refresh',
      apiErrorMessage: 'Failed to force PDF refresh',
      normalize: { code: 'DOCUMENTS_PARSED_FORCE_REFRESH_FAILED', errorClass: 'upstream' },
    });
  }
}
