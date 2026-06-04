import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  isWorkerOperationStateStale,
  snapshotFromWorkerState,
} from '@/lib/server/compute/worker-parse-state';
import { fetchWorkerOperationState } from '@/lib/server/compute/worker-op-state';
import {
  getParsedDocumentBlob,
  getParsedDocumentBlobByKey,
  isMissingBlobError,
  isValidDocumentId,
} from '@/lib/server/documents/blobstore';
import {
  normalizeDocumentParseStateForCurrentParserVersion,
  normalizeParseStatus,
  parseDocumentParseState,
  stringifyDocumentParseState,
} from '@/lib/server/documents/parse-state';
import { startPdfParseOperation } from '@/lib/server/documents/pdf-parse-operation';
import { healStaleDocumentParseState } from '@/lib/server/documents/parse-state-healing';
import { enqueueParsePdfJob } from '@/lib/server/jobs/user-pdf-layout-job';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { checkJobRate, getPdfLayoutRateConfig } from '@/lib/server/rate-limit/job-rate-limiter';
import { buildComputeRateLimitedResponse } from '@/lib/server/rate-limit/problem-response';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger, hashForLog } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import { getComputeOpStaleMs } from '@openreader/compute-core';
import type { PdfLayoutJobResult } from '@openreader/compute-core/api-contracts';

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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/parsed',
    request: req,
  });
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const authCtxOrRes = await requireAuthContext(req);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;
    if (!authCtxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const params = await ctx.params;
    const id = (params.id || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const storageUserId = authCtxOrRes.userId;
    const allowedUserIds = [storageUserId];

    const rows = await loadRows({ documentId: id, allowedUserIds });
    const row = pickPreferredRow(rows, storageUserId);
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const state = normalizeDocumentParseStateForCurrentParserVersion(parseDocumentParseState(row.parseState));
    const effectiveStatus = normalizeParseStatus(state.status);
    const effectiveProgress = state.progress ?? null;
    const effectiveOpId = normalizeOpId(state.opId);

    if (effectiveStatus !== 'ready') {
      return NextResponse.json({
        parseStatus: effectiveStatus,
        parseProgress: effectiveProgress,
        opId: effectiveOpId,
      }, { status: 409 });
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
    const opStaleMs = getComputeOpStaleMs();
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const authCtxOrRes = await requireAuthContext(req);
    if (authCtxOrRes instanceof Response) return authCtxOrRes;
    if (!authCtxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    const storageUserId = authCtxOrRes.userId;
    const allowedUserIds = [storageUserId];

    const rows = await loadRows({ documentId: id, allowedUserIds });
    const row = pickPreferredRow(rows, storageUserId);
    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let state = normalizeDocumentParseStateForCurrentParserVersion(parseDocumentParseState(row.parseState));
    state = await healStaleDocumentParseState({
      documentId: id,
      userId: row.userId,
      state,
    });

    const existingOpId = normalizeOpId(state.opId);
    if (existingOpId) {
      const existing = await fetchWorkerOperationState<PdfLayoutJobResult>(existingOpId);
      if (
        existing
        && !isWorkerOperationStateStale(existing, opStaleMs)
        && (existing.status === 'queued' || existing.status === 'running')
        && !replace
      ) {
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

    const forceToken = randomUUID();
    const startedParse = await startPdfParseOperation({
      documentId: id,
      userId: authCtxOrRes.userId,
      namespace: testNamespace,
      forceToken,
    });
    const snapshot = snapshotFromWorkerState(startedParse.workerState);
    await writeParseRowState({
      documentId: row.id,
      userId: row.userId,
      parseState: stringifyDocumentParseState(startedParse.parseState),
    });
    enqueueParsePdfJob({
      documentId: id,
      userId: row.userId,
      namespace: testNamespace,
      forceToken,
      initialOpId: startedParse.workerState.opId,
      initialJobId: startedParse.workerState.jobId,
      initialStatus: startedParse.parseState.status === 'running' ? 'running' : 'pending',
    });

    return NextResponse.json({
      parseStatus: snapshot.parseStatus,
      parseProgress: snapshot.parseProgress,
      opId: startedParse.workerState.opId,
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
