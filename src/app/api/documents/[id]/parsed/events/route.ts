import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import { snapshotFromWorkerState } from '@/lib/server/compute/worker-parse-state';
import { fetchWorkerOperationState } from '@/lib/server/compute/worker-op-state';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { normalizeParseStatus, parseDocumentParseState } from '@/lib/server/documents/parse-state';
import { healStaleDocumentParseState } from '@/lib/server/documents/parse-state-healing';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import { createRequestLogger, hashForLog } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { logDegraded, logServerError } from '@/lib/server/errors/logging';
import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import { parseSseEventId, parseSsePayload } from '@openreader/compute-core';
import type { PdfLayoutJobResult, WorkerOperationEvent, WorkerOperationState } from '@openreader/compute-core/api-contracts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

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
  opId?: string | null;
};

type SnapshotState = {
  snapshot: ParsedSnapshot;
  opId: string | null;
  fromWorker: boolean;
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

async function toSnapshotState(row: ParseRow, preferredOpId?: string | null): Promise<SnapshotState> {
  const state = await healStaleDocumentParseState({
    documentId: row.id,
    userId: row.userId,
    state: parseDocumentParseState(row.parseState),
  });
  const parseStatus = normalizeParseStatus(state.status);
  const dbOpId = typeof state.opId === 'string' && state.opId.trim() ? state.opId.trim() : null;
  const requestedOpId = preferredOpId?.trim() || null;
  const opId = requestedOpId ?? dbOpId;
  // When a caller pins an opId, that op is the live source of truth even if
  // the per-user document row currently says "ready" or has a different opId.
  if (opId && (requestedOpId !== null || parseStatus !== 'ready')) {
    const workerState = await fetchWorkerOperationState<PdfLayoutJobResult>(opId);
    if (workerState && workerState.opId === opId) {
      return {
        snapshot: {
          ...snapshotFromWorkerState(workerState),
          opId: workerState.opId,
        },
        opId: workerState.opId,
        fromWorker: true,
      };
    }
  }
  return {
    snapshot: {
      parseStatus,
      parseProgress: state.progress ?? null,
      opId,
    },
    opId,
    fromWorker: false,
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
  preferredOpId?: string | null;
  writeSnapshot: (snapshot: ParsedSnapshot) => void;
}): Promise<{ snapshot: ParsedSnapshot; opId: string | null; fromWorker: boolean; signature: string } | null> {
  const nextRow = await loadPreferredRow({
    documentId: input.documentId,
    storageUserId: input.storageUserId,
    allowedUserIds: input.allowedUserIds,
  });
  if (!nextRow) return null;

  const nextState = await toSnapshotState(nextRow, input.preferredOpId);
  const nextSignature = JSON.stringify(nextState.snapshot);
  if (nextSignature !== input.signature) {
    input.writeSnapshot(nextState.snapshot);
  }

  return {
    snapshot: nextState.snapshot,
    opId: nextState.opId,
    fromWorker: nextState.fromWorker,
    signature: nextSignature,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { logger, requestId } = createRequestLogger({
    route: '/api/documents/[id]/parsed/events',
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
    const requestedOpIdRaw = req.nextUrl.searchParams.get('opId');
    const requestedOpId = typeof requestedOpIdRaw === 'string' && requestedOpIdRaw.trim()
      ? requestedOpIdRaw.trim()
      : null;

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = authCtxOrRes.userId ?? unclaimedUserId;
    const storageUserIdHash = hashForLog(storageUserId);
    const allowedUserIds = authCtxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

    const row = await loadPreferredRow({
      documentId: id,
      storageUserId,
      allowedUserIds,
    });

    if (!row) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const initialState = await toSnapshotState(row, requestedOpId);
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
          let currentOpId = requestedOpId ?? initialState.opId;
          let currentFromWorker = initialState.fromWorker;
          let lastEventId: number | null = null;
          let loggedMissingOpId = false;
          const pinnedRequestedOp = requestedOpId ?? null;
          const shouldCloseForTerminalSnapshot = (snapshot: ParsedSnapshot, fromWorker: boolean): boolean => {
            const isTerminal = snapshot.parseStatus === 'ready' || snapshot.parseStatus === 'failed';
            if (!isTerminal) return false;
            // If caller pinned an opId, keep streaming until worker confirms that
            // op state. DB fallback can report stale terminal status for other rows.
            if (pinnedRequestedOp && snapshot.opId === pinnedRequestedOp && !fromWorker) return false;
            return true;
          };

          writeSnapshot(current);

          if (shouldCloseForTerminalSnapshot(current, currentFromWorker)) {
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
              preferredOpId: requestedOpId ?? currentOpId,
              writeSnapshot,
            }).then((next) => {
              if (closed) return;
              if (!next) {
                closeStream();
                return;
              }
              current = next.snapshot;
              signature = next.signature;
              currentFromWorker = next.fromWorker;
              if (!requestedOpId && next.opId !== currentOpId) {
                currentOpId = next.opId;
                lastEventId = null;
                if (workerAbort) {
                  workerAbort.abort();
                  workerAbort = null;
                }
              }
              if (shouldCloseForTerminalSnapshot(current, currentFromWorker)) {
                closeStream();
              }
            }).catch((error) => {
              if (closed) return;
              logDegraded(logger, {
                event: 'documents.parsed.events.db_resync_failed',
                msg: 'SSE DB resync failed',
                step: 'db_resync',
                context: {
                  documentId: id,
                  storageUserIdHash,
                  requestId,
                },
                error,
              });
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
                preferredOpId: requestedOpId ?? currentOpId,
                writeSnapshot,
              });
              if (!next) {
                closeStream();
                return;
              }
              current = next.snapshot;
              signature = next.signature;
              currentFromWorker = next.fromWorker;
              currentOpId = requestedOpId ?? next.opId;
              if (!currentOpId) {
                if (!loggedMissingOpId) {
                  loggedMissingOpId = true;
                  logger.warn({
                    event: 'documents.parsed.events.missing_opid_non_terminal',
                    degraded: true,
                    step: 'poll_without_worker_op',
                    documentId: id,
                    storageUserIdHash,
                    parseStatus: current.parseStatus,
                    requestedOpId,
                  }, 'Parse stream running without opId and non-terminal status');
                }
              } else if (loggedMissingOpId) {
                loggedMissingOpId = false;
              }
              if (shouldCloseForTerminalSnapshot(current, currentFromWorker)) {
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
              const upstreamResponseBody = await response.text().catch(() => '');
              logger.warn({
                event: 'documents.parsed.events.worker_stream_request_failed',
                degraded: true,
                step: 'worker_stream_request',
                documentId: id,
                opId: currentOpId,
                status: response.status,
                upstreamResponseBody,
                error: {
                  name: 'WorkerStreamRequestFailed',
                  message: `Worker stream request failed with status ${response.status}`,
                },
              }, 'Worker stream request failed');
              await sleep(500);
              continue;
            }
            if (!response.body) {
              logger.warn({
                event: 'documents.parsed.events.worker_stream_missing_body',
                degraded: true,
                step: 'worker_stream_body',
                documentId: id,
                opId: currentOpId,
                error: {
                  name: 'WorkerStreamMissingBody',
                  message: 'Worker stream response missing body',
                },
              }, 'Worker stream response missing body');
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

                const nextSnapshot: ParsedSnapshot = {
                  ...snapshotFromWorkerState(workerSnapshot),
                  opId: workerSnapshot.opId,
                };
                const nextSignature = JSON.stringify(nextSnapshot);
                if (nextSignature !== signature) {
                  current = nextSnapshot;
                  signature = nextSignature;
                  currentFromWorker = true;
                  writeSnapshot(current);
                }

                if (shouldCloseForTerminalSnapshot(current, currentFromWorker)) {
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
              preferredOpId: requestedOpId ?? currentOpId,
              writeSnapshot,
            });
            if (!next) {
              closeStream();
              return;
            }
            current = next.snapshot;
            signature = next.signature;
            currentFromWorker = next.fromWorker;
            if (!requestedOpId && next.opId !== currentOpId) {
              currentOpId = next.opId;
              lastEventId = null;
            }
            if (shouldCloseForTerminalSnapshot(current, currentFromWorker)) {
              closeStream();
              return;
            }
            await sleep(250);
          }
        };

        void runWorkerProxy()
          .catch((error) => {
            logServerError(logger, {
              event: 'documents.parsed.events.worker_proxy_crashed',
              error,
              msg: 'Worker proxy crashed while streaming parse events',
              context: { documentId: id },
              normalize: {
                code: 'DOCUMENTS_PARSED_EVENTS_WORKER_PROXY_CRASHED',
                errorClass: 'upstream',
              },
            });
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
    return errorResponse(error, {
      logger,
      event: 'documents.parsed.events.route_failed',
      msg: 'Parsed events route failed',
      apiErrorMessage: 'Failed to stream parsed PDF progress',
      normalize: { code: 'DOCUMENTS_PARSED_EVENTS_ROUTE_FAILED', errorClass: 'upstream' },
    });
  }
}
