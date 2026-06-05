import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import {
  fetchPdfParseOperation,
  isPdfParseOperationForDocument,
} from '@/lib/server/pdf-parse/operation';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

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

function workerEventsUrl(baseUrl: string, opId: string, sinceEventId: string | null): string {
  const url = new URL(`${baseUrl}/ops/${encodeURIComponent(opId)}/events`);
  if (sinceEventId) {
    url.searchParams.set('sinceEventId', sinceEventId);
  }
  return url.toString();
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/parsed/events',
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

    const opId = (req.nextUrl.searchParams.get('opId') || '').trim();
    if (!opId) {
      return NextResponse.json({ error: 'opId is required' }, { status: 400 });
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
    const initialState = await fetchPdfParseOperation(opId);
    if (!initialState || !isPdfParseOperationForDocument(initialState, { documentId: id, namespace })) {
      return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
    }

    const cfg = getWorkerClientConfigFromEnv();
    const lastEventId = req.headers.get('last-event-id');
    const sinceEventId = req.nextUrl.searchParams.get('sinceEventId') || lastEventId;
    const upstream = await fetch(workerEventsUrl(cfg.baseUrl, opId, sinceEventId), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'text/event-stream',
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      cache: 'no-store',
      signal: req.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: detail || 'Failed to proxy parse event stream' },
        { status: upstream.status || 502 },
      );
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
        'Cache-Control': upstream.headers.get('cache-control') || 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'documents.parsed.events_failed',
      msg: 'Failed to proxy parsed PDF events',
      apiErrorMessage: 'Failed to proxy parsed PDF events',
      normalize: { code: 'DOCUMENTS_PARSED_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}
