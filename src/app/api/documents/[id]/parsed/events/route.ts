import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import { fetchWorkerOperationState } from '@/lib/server/compute/worker-op-state';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { normalizeParseStatus, parseDocumentParseState } from '@/lib/server/documents/parse-state';
import { healStaleDocumentParseState } from '@/lib/server/documents/parse-state-healing';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import { parseSseEventId, parseSsePayload } from '@openreader/compute-core';
import type { PdfLayoutJobResult, WorkerOperationEvent, WorkerOperationState } from '@openreader/compute-core/api-contracts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_KEEPALIVE_MS = 15_000;
const SSE_RESYNC_INTERVAL_MS = 30_000;

type ParseRow = {
  id: string;
  userId: string;
  parseState: string | null;
};

type ParsedSnapshot = {
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
};

type SnapshotState = {
  snapshot: ParsedSnapshot;
  opId: string | null;
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

function mapWorkerStatusToParseStatus(status: WorkerOperationState['status']): PdfParseStatus {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'ready';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

function snapshotFromWorkerState(state: WorkerOperationState<PdfLayoutJobResult>): ParsedSnapshot {
  const parseStatus = mapWorkerStatusToParseStatus(state.status);
  return {
    parseStatus,
    parseProgress: parseStatus === 'running' ? (state.progress ?? null) : null,
  };
}

async function toSnapshotState(row: ParseRow): Promise<SnapshotState> {
  const state = await healStaleDocumentParseState({
    documentId: row.id,
    userId: row.userId,
    state: parseDocumentParseState(row.parseState),
  });
  const parseStatus = normalizeParseStatus(state.status);
  const opId = typeof state.opId === 'string' && state.opId.trim() ? state.opId.trim() : null;
  if (opId && parseStatus !== 'ready') {
    const workerState = await fetchWorkerOperationState<PdfLayoutJobResult>(opId);
    if (workerState && workerState.opId === opId) {
      return {
        snapshot: snapshotFromWorkerState(workerState),
        opId,
      };
    }
  }
  return {
    snapshot: {
      parseStatus,
      parseProgress: state.progress ?? null,
    },
    opId,
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

async function syncFromDb(input: {
  documentId: string;
  storageUserId: string;
  allowedUserIds: string[];
  signature: string;
  writeSnapshot: (snapshot: ParsedSnapshot) => void;
}): Promise<{ snapshot: ParsedSnapshot; opId: string | null; signature: string } | null> {
  const nextRow = await loadPreferredRow({
    documentId: input.documentId,
    storageUserId: input.storageUserId,
    allowedUserIds: input.allowedUserIds,
  });
  if (!nextRow) return null;

  const nextState = await toSnapshotState(nextRow);
  const nextSignature = JSON.stringify(nextState.snapshot);
  if (nextSignature !== input.signature) {
    input.writeSnapshot(nextState.snapshot);
  }

  return {
    snapshot: nextState.snapshot,
    opId: nextState.opId,
    signature: nextSignature,
  };
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

    const initialState = await toSnapshotState(row);
    const workerCfg = getWorkerClientConfigFromEnv();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
        let resyncTimer: ReturnType<typeof setInterval> | null = null;
        let workerAbort: AbortController | null = null;

        const writeSnapshot = (snapshot: ParsedSnapshot): void => {
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
        };

        const closeStream = (): void => {
          if (closed) return;
          closed = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          if (resyncTimer) {
            clearInterval(resyncTimer);
            resyncTimer = null;
          }
          if (workerAbort) {
            workerAbort.abort();
            workerAbort = null;
          }
          try {
            controller.close();
          } catch {
            // no-op
          }
        };

        const runWorkerProxy = async () => {
          let current = initialState.snapshot;
          let signature = JSON.stringify(current);
          let currentOpId = initialState.opId;
          let lastEventId: number | null = null;

          writeSnapshot(current);

          if (current.parseStatus === 'ready' || current.parseStatus === 'failed') {
            closeStream();
            return;
          }

          keepaliveTimer = setInterval(() => {
            if (closed) return;
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }, SSE_KEEPALIVE_MS);

          resyncTimer = setInterval(() => {
            if (closed) return;
            void syncFromDb({
              documentId: id,
              storageUserId,
              allowedUserIds,
              signature,
              writeSnapshot,
            }).then((next) => {
              if (closed) return;
              if (!next) {
                closeStream();
                return;
              }
              current = next.snapshot;
              signature = next.signature;
              if (next.opId !== currentOpId) {
                currentOpId = next.opId;
                lastEventId = null;
                if (workerAbort) {
                  workerAbort.abort();
                  workerAbort = null;
                }
              }
              if (current.parseStatus === 'ready' || current.parseStatus === 'failed') {
                closeStream();
              }
            }).catch((error) => {
              if (closed) return;
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`));
            });
          }, SSE_RESYNC_INTERVAL_MS);

          while (!closed) {
            if (!currentOpId) {
              await sleep(SSE_RESYNC_INTERVAL_MS);
              const next = await syncFromDb({
                documentId: id,
                storageUserId,
                allowedUserIds,
                signature,
                writeSnapshot,
              });
              if (!next) {
                closeStream();
                return;
              }
              current = next.snapshot;
              signature = next.signature;
              currentOpId = next.opId;
              if (current.parseStatus === 'ready' || current.parseStatus === 'failed') {
                closeStream();
                return;
              }
              continue;
            }

            workerAbort = new AbortController();
            const query = lastEventId && lastEventId > 0
              ? `?sinceEventId=${encodeURIComponent(String(lastEventId))}`
              : '';
            const response = await fetch(
              `${workerCfg.baseUrl}/ops/${encodeURIComponent(currentOpId)}/events${query}`,
              {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${workerCfg.token}`,
                  Accept: 'text/event-stream',
                  ...(lastEventId && lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {}),
                },
                cache: 'no-store',
                signal: workerAbort.signal,
              },
            );

            if (closed) return;

            if (!response.ok) {
              const detail = await response.text().catch(() => '');
              console.warn('[parsed/events] worker stream request failed', {
                documentId: id,
                opId: currentOpId,
                status: response.status,
                detail,
              });
              await sleep(500);
              continue;
            }
            if (!response.body) {
              await sleep(500);
              continue;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let streamEnded = false;

            while (!closed && !streamEnded) {
              const read = await reader.read();
              if (read.done) {
                streamEnded = true;
                break;
              }

              buffer += decoder.decode(read.value, { stream: true });

              while (true) {
                const frameEnd = buffer.indexOf('\n\n');
                if (frameEnd < 0) break;
                const frame = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);

                const eventId = parseSseEventId(frame);
                if (eventId && eventId > 0) {
                  lastEventId = eventId;
                }

                const payload = parseSsePayload(frame);
                if (!payload) continue;

                let parsed: WorkerOperationEvent<PdfLayoutJobResult> | WorkerOperationState<PdfLayoutJobResult>;
                try {
                  parsed = JSON.parse(payload) as WorkerOperationEvent<PdfLayoutJobResult> | WorkerOperationState<PdfLayoutJobResult>;
                } catch {
                  continue;
                }

                const workerSnapshot: WorkerOperationState<PdfLayoutJobResult> = (
                  parsed && typeof parsed === 'object' && 'snapshot' in parsed
                    ? parsed.snapshot
                    : parsed as WorkerOperationState<PdfLayoutJobResult>
                );
                if (!workerSnapshot || workerSnapshot.opId !== currentOpId) continue;

                const nextSnapshot = snapshotFromWorkerState(workerSnapshot);
                const nextSignature = JSON.stringify(nextSnapshot);
                if (nextSignature !== signature) {
                  current = nextSnapshot;
                  signature = nextSignature;
                  writeSnapshot(current);
                }

                if (current.parseStatus === 'ready' || current.parseStatus === 'failed') {
                  closeStream();
                  return;
                }
              }
            }

            if (closed) return;

            const next = await syncFromDb({
              documentId: id,
              storageUserId,
              allowedUserIds,
              signature,
              writeSnapshot,
            });
            if (!next) {
              closeStream();
              return;
            }
            current = next.snapshot;
            signature = next.signature;
            if (next.opId !== currentOpId) {
              currentOpId = next.opId;
              lastEventId = null;
            }
            if (current.parseStatus === 'ready' || current.parseStatus === 'failed') {
              closeStream();
              return;
            }
            await sleep(250);
          }
        };

        void runWorkerProxy()
          .catch((error) => {
            if (!closed) {
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`));
            }
          })
          .finally(() => {
            closeStream();
          });

        req.signal.addEventListener('abort', () => {
          closeStream();
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
