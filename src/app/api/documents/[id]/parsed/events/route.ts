import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { enqueueParsePdfJob } from '@/lib/server/jobs/user-pdf-layout-job';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { normalizeParseStatus, parseDocumentParseState } from '@/lib/server/documents/parse-state';
import { healStaleDocumentParseState } from '@/lib/server/documents/parse-state-healing';

export const dynamic = 'force-dynamic';

const SSE_POLL_INTERVAL_MS = 1200;

type ParseRow = {
  id: string;
  userId: string;
  parseState: string | null;
};

type ParsedSnapshot = {
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
};

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toSnapshot(row: ParseRow): Promise<ParsedSnapshot> {
  const state = await healStaleDocumentParseState({
    documentId: row.id,
    userId: row.userId,
    state: parseDocumentParseState(row.parseState),
  });
  const parseStatus = normalizeParseStatus(state.status);
  return {
    parseStatus,
    parseProgress: state.progress ?? null,
  };
}

async function loadPreferredRow(input: {
  documentId: string;
  storageUserId: string;
  allowedUserIds: string[];
}): Promise<ParseRow | null> {
  const rows = (await db
    .select({
      id: documents.id,
      userId: documents.userId,
      parseState: documents.parseState,
    })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), inArray(documents.userId, input.allowedUserIds)))) as ParseRow[];

  return rows.find((candidate) => candidate.userId === input.storageUserId) ?? rows[0] ?? null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

    const row = await loadPreferredRow({
      documentId: id,
      storageUserId,
      allowedUserIds,
    });

    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const initial = await toSnapshot(row);
    if (initial.parseStatus === 'pending') {
      enqueueParsePdfJob({
        documentId: id,
        userId: row.userId,
        namespace: testNamespace,
      });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const writeSnapshot = (snapshot: ParsedSnapshot): void => {
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
        };

        const run = async () => {
          let current = initial;
          writeSnapshot(current);
          let signature = JSON.stringify(current);

          while (!closed) {
            if (current.parseStatus === 'ready' || current.parseStatus === 'failed') break;
            await sleep(SSE_POLL_INTERVAL_MS);
            if (closed) break;

            const nextRow = await loadPreferredRow({
              documentId: id,
              storageUserId,
              allowedUserIds,
            });
            if (!nextRow) break;

            const next = await toSnapshot(nextRow);
            if (next.parseStatus === 'pending') {
              enqueueParsePdfJob({
                documentId: id,
                userId: nextRow.userId,
                namespace: testNamespace,
              });
            }

            const nextSignature = JSON.stringify(next);
            if (nextSignature !== signature) {
              current = next;
              signature = nextSignature;
              writeSnapshot(current);
            }
          }
        };

        void run()
          .catch((error) => {
            if (!closed) {
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`));
            }
          })
          .finally(() => {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // no-op
              }
            }
          });

        req.signal.addEventListener('abort', () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // no-op
          }
        }, { once: true });
      },
      cancel() {
        return;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('Error streaming parsed PDF progress:', error);
    return NextResponse.json({ error: 'Failed to stream parsed PDF progress' }, { status: 500 });
  }
}
