import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import {
  createOrReuseCurrentPdfParseOperation,
  resolveCurrentPdfParse,
} from '@/lib/server/pdf-parse/operation';
import { pdfParseSnapshotFromWorkerState } from '@/lib/server/pdf-parse/snapshot';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { checkJobRate, getPdfLayoutRateConfig } from '@/lib/server/rate-limit/job-rate-limiter';
import { buildComputeRateLimitedResponse } from '@/lib/server/rate-limit/problem-response';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import type { PdfParseSnapshot } from '@/lib/server/pdf-parse/types';

export const dynamic = 'force-dynamic';

type DocumentRow = {
  id: string;
  type: string;
};

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

async function loadOwnedDocumentRow(input: {
  documentId: string;
  allowedUserIds: string[];
}): Promise<DocumentRow | null> {
  const rows = (await db
    .select({
      id: documents.id,
      type: documents.type,
    })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), inArray(documents.userId, input.allowedUserIds)))
    .limit(1)) as DocumentRow[];
  return rows[0] ?? null;
}

function jsonSnapshot(snapshot: PdfParseSnapshot, status = 409): NextResponse {
  return NextResponse.json(snapshot, { status });
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

    const row = await loadOwnedDocumentRow({
      documentId: id,
      allowedUserIds: [authCtxOrRes.userId],
    });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.type !== 'pdf') {
      return NextResponse.json({ error: 'Document is not a PDF' }, { status: 400 });
    }

    const namespace = getOpenReaderTestNamespace(req.headers);
    const resolved = await resolveCurrentPdfParse({ documentId: id, namespace });
    if (resolved.artifact) {
      return jsonSnapshot({ parseStatus: 'ready', parseProgress: null, opId: null }, 200);
    }

    const currentOp = resolved.operation;
    if (!currentOp) {
      return jsonSnapshot({
        parseStatus: 'pending',
        parseProgress: null,
        opId: null,
      });
    }

    if (currentOp.status === 'succeeded') {
      return NextResponse.json(
        {
          error: 'Current parse operation succeeded without a readable parsed artifact.',
          opId: currentOp.opId,
        },
        { status: 502 },
      );
    }

    return jsonSnapshot(pdfParseSnapshotFromWorkerState(currentOp));
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

    const row = await loadOwnedDocumentRow({
      documentId: id,
      allowedUserIds: [authCtxOrRes.userId],
    });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.type !== 'pdf') {
      return NextResponse.json({ error: 'Document is not a PDF' }, { status: 400 });
    }

    const namespace = getOpenReaderTestNamespace(req.headers);

    if (!replace) {
      const resolved = await resolveCurrentPdfParse({ documentId: id, namespace });
      if (resolved.artifact) {
        return jsonSnapshot({
          parseStatus: 'ready',
          parseProgress: null,
          opId: null,
        }, 200);
      }

      const currentOp = resolved.operation;
      if (currentOp) {
        const snapshot = pdfParseSnapshotFromWorkerState(currentOp);
        if (snapshot.parseStatus === 'failed') {
          return jsonSnapshot(snapshot);
        }
        if (snapshot.parseStatus === 'ready') {
          return jsonSnapshot({
            parseStatus: 'running',
            parseProgress: null,
            opId: snapshot.opId,
          }, 202);
        }
        return jsonSnapshot(snapshot, 202);
      }
    }

    const rateConfig = getPdfLayoutRateConfig(await getResolvedRuntimeConfig());
    const rateDecision = await checkJobRate(authCtxOrRes.userId, 'pdf_layout', rateConfig);
    if (!rateDecision.allowed) {
      return buildComputeRateLimitedResponse({ decision: rateDecision, pathname: req.nextUrl.pathname });
    }

    const workerState = await createOrReuseCurrentPdfParseOperation({
      documentId: id,
      namespace,
      ...(replace ? { forceToken: randomUUID() } : {}),
    });

    return jsonSnapshot(pdfParseSnapshotFromWorkerState(workerState), 202);
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'documents.parsed.ensure_failed',
      msg: 'Failed to ensure parsed PDF operation',
      apiErrorMessage: 'Failed to ensure parsed PDF operation',
      normalize: { code: 'DOCUMENTS_PARSED_ENSURE_FAILED', errorClass: 'upstream' },
    });
  }
}
