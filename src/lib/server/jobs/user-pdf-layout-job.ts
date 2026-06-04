import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { documentKey, getParsedDocumentBlobByKey, putParsedDocumentBlob } from '@/lib/server/documents/blobstore';
import { findReusableParsedPdfResult } from '@/lib/server/documents/parsed-pdf-reuse';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded, logServerError } from '@/lib/server/errors/logging';
import {
  normalizeDocumentParseStateForCurrentParserVersion,
  parseDocumentParseState,
  resolveParsedPdfParserVersion,
  stringifyDocumentParseState,
  type DocumentParseState,
} from '@/lib/server/documents/parse-state';
import { getCompute } from '@/lib/server/compute';
import { clearTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { UNCLAIMED_USER_ID } from '@/lib/server/storage/docstore-legacy';
import type {
  ParsedPdfDocument,
  PdfLayoutJobBase,
  PdfLayoutJobResult,
  PdfLayoutProgress,
  WorkerOperationState,
} from '@openreader/compute-core/api-contracts';
import { PDF_PARSER_VERSION } from '@openreader/compute-core';

type UserPdfLayoutJobRequest = PdfLayoutJobBase & {
  userId: string;
  forceToken?: string;
  initialOpId?: string;
  initialJobId?: string;
  initialStatus?: 'pending' | 'running';
};

const running = new Set<string>();

const FOLLOWER_WAIT_TIMEOUT_MS = 180_000;
const FOLLOWER_POLL_MS = 1_200;
const PROGRESS_DB_THROTTLE_MS = 10_000;

type ParseRow = {
  userId: string;
  parseState: string | null;
  parsedJsonKey: string | null;
};

function keyFor(input: UserPdfLayoutJobRequest): string {
  const forceToken = input.forceToken?.trim();
  if (forceToken) {
    return `force:${input.documentId}:${input.namespace || ''}:${forceToken}`;
  }
  return `shared:${input.documentId}`;
}

function normalizeOpId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferNamespaceFromUnclaimedUserId(userId: string): string | null {
  const prefix = `${UNCLAIMED_USER_ID}::`;
  if (!userId.startsWith(prefix)) return null;
  const ns = userId.slice(prefix.length).trim();
  return ns || null;
}

function rowMatchesScope(row: ParseRow, input: UserPdfLayoutJobRequest): boolean {
  const inferredNamespace = inferNamespaceFromUnclaimedUserId(row.userId);
  if (inferredNamespace !== null) {
    return inferredNamespace === (input.namespace ?? null);
  }

  // Regular (non-unclaimed) users are only shared in the non-namespaced path.
  if (!input.namespace) return true;

  // In namespaced contexts with regular users, avoid touching other users'
  // rows since namespace is not persisted on document rows.
  return row.userId === input.userId;
}

async function loadScopedRows(input: UserPdfLayoutJobRequest): Promise<ParseRow[]> {
  const rows = (await db
    .select({
      userId: documents.userId,
      parseState: documents.parseState,
      parsedJsonKey: documents.parsedJsonKey,
    })
    .from(documents)
    .where(eq(documents.id, input.documentId))) as ParseRow[];

  return rows.filter((row) => rowMatchesScope(row, input));
}

function isReadyRow(row: ParseRow): row is ParseRow & { parsedJsonKey: string } {
  if (!row.parsedJsonKey) return false;
  return normalizeDocumentParseStateForCurrentParserVersion(parseDocumentParseState(row.parseState)).status === 'ready';
}

function userIdsFromRows(rows: ParseRow[]): string[] {
  return Array.from(new Set(rows.map((row) => row.userId).filter(Boolean)));
}

function parseStateMatchCondition(expected: string | null) {
  return expected === null ? isNull(documents.parseState) : eq(documents.parseState, expected);
}

async function loadParsedDocumentForResult(
  parsed: ParsedPdfDocument | undefined,
  parsedJsonKey: string,
): Promise<ParsedPdfDocument | null> {
  if (parsed) return parsed;

  try {
    const json = await getParsedDocumentBlobByKey(parsedJsonKey);
    return JSON.parse(Buffer.from(json).toString('utf8')) as ParsedPdfDocument;
  } catch {
    return null;
  }
}

async function updateParseStateForUsers(input: {
  documentId: string;
  userIds: string[];
  parseState: string;
  parsedJsonKey?: string | null;
}): Promise<void> {
  if (input.userIds.length === 0) return;

  await db
    .update(documents)
    .set({
      parseState: input.parseState,
      ...(typeof input.parsedJsonKey === 'string' || input.parsedJsonKey === null
        ? { parsedJsonKey: input.parsedJsonKey }
        : {}),
    })
    .where(
      and(
        eq(documents.id, input.documentId),
        input.userIds.length === 1
          ? eq(documents.userId, input.userIds[0])
          : inArray(documents.userId, input.userIds),
      ),
    );
}

async function syncCallerToSharedResult(input: UserPdfLayoutJobRequest): Promise<void> {
  const deadline = Date.now() + FOLLOWER_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const reusableParsed = await findReusableParsedPdfResult(input.documentId);
    if (reusableParsed) {
      const readyState: DocumentParseState = {
        status: 'ready',
        progress: null,
        updatedAt: Date.now(),
        parserVersion: PDF_PARSER_VERSION,
      };
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: [input.userId],
        parseState: stringifyDocumentParseState(readyState),
        parsedJsonKey: reusableParsed.parsedJsonKey,
      });
      return;
    }

    const rows = await loadScopedRows(input);
    const ready = rows.find(isReadyRow);
    if (ready) {
      const readyState: DocumentParseState = {
        status: 'ready',
        progress: null,
        updatedAt: Date.now(),
        parserVersion: PDF_PARSER_VERSION,
      };
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: [input.userId],
        parseState: stringifyDocumentParseState(readyState),
        parsedJsonKey: ready.parsedJsonKey,
      });
      return;
    }

    const statuses = rows.map((row) => normalizeDocumentParseStateForCurrentParserVersion(parseDocumentParseState(row.parseState)));
    const hasInFlight = statuses.some((state) => state.status === 'pending' || state.status === 'running');
    const failedState = statuses.find((state) => state.status === 'failed');
    if (failedState && !hasInFlight) {
      const nextFailedState: DocumentParseState = {
        status: 'failed',
        progress: null,
        updatedAt: Date.now(),
        ...(failedState.error ? { error: failedState.error } : {}),
        ...(failedState.parserVersion ? { parserVersion: failedState.parserVersion } : {}),
      };
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: [input.userId],
        parseState: stringifyDocumentParseState(nextFailedState),
      });
      return;
    }

    await sleep(FOLLOWER_POLL_MS);
  }
}

export async function parsePdfJob(input: UserPdfLayoutJobRequest): Promise<void> {
  const key = keyFor(input);
  if (running.has(key)) {
    if (!input.forceToken?.trim()) {
      await syncCallerToSharedResult(input);
    }
    return;
  }
  running.add(key);

  let activeOpId = normalizeOpId(input.initialOpId);
  let activeJobId = normalizeOpId(input.initialJobId);
  try {
    const scopedRows = await loadScopedRows(input);
    const scopedUserIds = userIdsFromRows(scopedRows);

    // Non-force jobs can short-circuit by reusing existing ready output from
    // any row in the same document scope.
    if (!input.forceToken?.trim()) {
      const reusableParsed = await findReusableParsedPdfResult(input.documentId);
      if (reusableParsed) {
        const readyState: DocumentParseState = {
          status: 'ready',
          progress: null,
          updatedAt: Date.now(),
          parserVersion: PDF_PARSER_VERSION,
        };
        await updateParseStateForUsers({
          documentId: input.documentId,
          userIds: [input.userId],
          parseState: stringifyDocumentParseState(readyState),
          parsedJsonKey: reusableParsed.parsedJsonKey,
        });
        return;
      }

      const ready = scopedRows.find(isReadyRow);
      if (ready) {
        const readyState: DocumentParseState = {
          status: 'ready',
          progress: null,
          updatedAt: Date.now(),
          parserVersion: PDF_PARSER_VERSION,
        };
        await updateParseStateForUsers({
          documentId: input.documentId,
          userIds: [input.userId],
          parseState: stringifyDocumentParseState(readyState),
          parsedJsonKey: ready.parsedJsonKey,
        });
        return;
      }
    }

    const coordinator = [...scopedRows].sort((a, b) => a.userId.localeCompare(b.userId))[0];
    if (!coordinator) return;

    const initialInflightStatus = input.initialStatus === 'running' ? 'running' : 'pending';
    const inflightStateData: DocumentParseState = {
      status: initialInflightStatus,
      progress: null,
      updatedAt: Date.now(),
      parserVersion: PDF_PARSER_VERSION,
      ...(activeOpId ? { opId: activeOpId } : {}),
      ...(activeJobId ? { jobId: activeJobId } : {}),
    };
    const inflightState = stringifyDocumentParseState(inflightStateData);

    const claimRows = (await db
      .update(documents)
      .set({
        parseState: inflightState,
      })
      .where(
        and(
          eq(documents.id, input.documentId),
          eq(documents.userId, coordinator.userId),
          parseStateMatchCondition(coordinator.parseState),
        ),
      )
      .returning({ userId: documents.userId })) as Array<{ userId: string }>;

    const claimed = claimRows.some((row) => row.userId === coordinator.userId);
    if (!claimed) {
      if (!input.forceToken?.trim()) {
        await syncCallerToSharedResult(input);
      }
      return;
    }

    const cohortUserIds = Array.from(new Set([...scopedUserIds, input.userId, coordinator.userId]));
    await updateParseStateForUsers({
      documentId: input.documentId,
      userIds: cohortUserIds,
      parseState: inflightState,
    });

    const compute = await getCompute();
    let lastProgressWriteAt = 0;
    let lastSnapshotWriteAt = 0;
    let lastSnapshotStatus: 'pending' | 'running' | null = null;
    let lastSnapshotOpId: string | undefined;
    let lastSnapshotJobId: string | undefined;

    const persistRunningState = async (state: DocumentParseState): Promise<void> => {
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: cohortUserIds,
        parseState: stringifyDocumentParseState(state),
      });
    };

    const onWorkerSnapshot = async (snapshot: WorkerOperationState<PdfLayoutJobResult>): Promise<void> => {
      if (snapshot.opId) activeOpId = snapshot.opId;
      if (snapshot.jobId) activeJobId = snapshot.jobId;

      const mappedStatus = snapshot.status === 'queued'
        ? 'pending'
        : snapshot.status === 'running'
          ? 'running'
          : null;
      if (!mappedStatus) return;

      const now = Date.now();
      const forceWrite = (
        mappedStatus !== lastSnapshotStatus
        || activeOpId !== lastSnapshotOpId
        || activeJobId !== lastSnapshotJobId
      );
      if (!forceWrite && (now - lastSnapshotWriteAt) < PROGRESS_DB_THROTTLE_MS) {
        return;
      }

      const nextState: DocumentParseState = {
        status: mappedStatus,
        progress: snapshot.progress ?? null,
        updatedAt: now,
        parserVersion: PDF_PARSER_VERSION,
        ...(activeOpId ? { opId: activeOpId } : {}),
        ...(activeJobId ? { jobId: activeJobId } : {}),
      };
      await persistRunningState(nextState);
      lastSnapshotWriteAt = now;
      lastSnapshotStatus = mappedStatus;
      lastSnapshotOpId = activeOpId;
      lastSnapshotJobId = activeJobId;
    };

    const writeProgress = async (progress: PdfLayoutProgress): Promise<void> => {
      const now = Date.now();
      if ((now - lastProgressWriteAt) < PROGRESS_DB_THROTTLE_MS && progress.pagesParsed < progress.totalPages) {
        return;
      }
      lastProgressWriteAt = now;

      const runningProgressState: DocumentParseState = {
        status: 'running',
        progress: {
          totalPages: progress.totalPages,
          pagesParsed: progress.pagesParsed,
          currentPage: progress.currentPage,
          phase: progress.phase,
        },
        updatedAt: Date.now(),
        parserVersion: PDF_PARSER_VERSION,
        ...(activeOpId ? { opId: activeOpId } : {}),
        ...(activeJobId ? { jobId: activeJobId } : {}),
      };
      await persistRunningState(runningProgressState);
    };

    const layout = await compute.parsePdfLayout({
      documentId: input.documentId,
      namespace: input.namespace,
      documentObjectKey: documentKey(input.documentId, input.namespace),
      forceToken: input.forceToken,
      onProgress: writeProgress,
      onWorkerSnapshot,
    });

    let parsedJsonKey = layout.parsedObjectKey ?? null;
    if (!parsedJsonKey) {
      if (!layout.parsed) throw new Error('Compute backend did not return parsed result');
      const parsedJson = Buffer.from(JSON.stringify(layout.parsed));
      parsedJsonKey = await putParsedDocumentBlob(input.documentId, parsedJson, input.namespace);
    }

    const parsedDoc = await loadParsedDocumentForResult(layout.parsed, parsedJsonKey);

    const finalScopedRows = await loadScopedRows(input);
    const finalUserIds = userIdsFromRows(finalScopedRows);
    const readyState: DocumentParseState = {
      status: 'ready',
      progress: null,
      updatedAt: Date.now(),
      parserVersion: resolveParsedPdfParserVersion(parsedDoc),
      ...(activeOpId ? { opId: activeOpId } : {}),
      ...(activeJobId ? { jobId: activeJobId } : {}),
    };
    const readyUserIds = finalUserIds.length > 0 ? finalUserIds : cohortUserIds;
    await updateParseStateForUsers({
      documentId: input.documentId,
      userIds: readyUserIds,
      parseState: stringifyDocumentParseState(readyState),
      parsedJsonKey,
    });

    // Best-effort cache invalidation should not block parse readiness.
    for (const userId of readyUserIds) {
      void clearTtsSegmentCache({
        userId,
        documentId: input.documentId,
        readerType: 'pdf',
      }).then((cleared) => {
        if (cleared.warning) {
          logDegraded(serverLogger, {
            event: 'documents.parse.cache_invalidation.warning',
            msg: 'Parse cache invalidation warning',
            step: 'clear_tts_segment_cache',
            context: {
              documentId: input.documentId,
              userId,
              warning: cleared.warning,
            },
          });
        }
      }).catch((cacheError) => {
        logDegraded(serverLogger, {
          event: 'documents.parse.cache_invalidation.failed',
          msg: 'Parse cache invalidation failed',
          step: 'clear_tts_segment_cache',
          context: {
            documentId: input.documentId,
            userId,
          },
          error: cacheError,
        });
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const parseStatus = 'failed';
    try {
      const scopedRows = await loadScopedRows(input);
      const scopedUserIds = userIdsFromRows(scopedRows);
      const failedState: DocumentParseState = {
        status: 'failed',
        progress: null,
        updatedAt: Date.now(),
        error: message,
        parserVersion: PDF_PARSER_VERSION,
        ...(activeOpId ? { opId: activeOpId } : {}),
        ...(activeJobId ? { jobId: activeJobId } : {}),
      };
      const failedUserIds = scopedUserIds.length > 0 ? scopedUserIds : [input.userId];
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: failedUserIds,
        parseState: stringifyDocumentParseState(failedState),
      });
    } catch (statusError) {
      logServerError(serverLogger, {
        event: 'documents.parse.status_write.failed',
        msg: 'Failed to write parse status',
        error: statusError,
        context: {
          documentId: input.documentId,
          parseStatus,
        },
        normalize: { code: 'DOCUMENT_PARSE_STATUS_WRITE_FAILED', errorClass: 'db' },
      });
    }
    logServerError(serverLogger, {
      event: 'documents.parse.job.failed',
      msg: 'Parse job failed',
      error,
      context: {
        documentId: input.documentId,
        parseStatus,
      },
      normalize: { code: 'DOCUMENT_PARSE_JOB_FAILED', errorClass: 'upstream' },
    });
  } finally {
    running.delete(key);
  }
}

export function enqueueParsePdfJob(input: UserPdfLayoutJobRequest): void {
  Promise.resolve()
    .then(() => parsePdfJob(input))
    .catch((error) => {
      logServerError(serverLogger, {
        event: 'documents.parse.job.uncaught_error',
        msg: 'Parse job uncaught error',
        error,
        context: { documentId: input.documentId },
        normalize: { code: 'DOCUMENT_PARSE_JOB_UNCAUGHT_ERROR', errorClass: 'unknown' },
      });
    });
}
