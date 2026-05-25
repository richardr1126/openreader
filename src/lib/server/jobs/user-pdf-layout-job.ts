import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { documentKey, putParsedDocumentBlob } from '@/lib/server/documents/blobstore';
import { parseDocumentParseState, stringifyDocumentParseState } from '@/lib/server/documents/parse-state';
import { getCompute } from '@/lib/server/compute';
import { clearTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { UNCLAIMED_USER_ID } from '@/lib/server/storage/docstore-legacy';
import type { PdfLayoutJobBase, PdfLayoutProgress } from '@openreader/compute-core/api-contracts';

type UserPdfLayoutJobRequest = PdfLayoutJobBase & {
  userId: string;
  forceToken?: string;
};

const running = new Set<string>();

const FOLLOWER_WAIT_TIMEOUT_MS = 180_000;
const FOLLOWER_POLL_MS = 1_200;

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
  return `shared:${input.documentId}:${input.namespace || ''}`;
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
  return parseDocumentParseState(row.parseState).status === 'ready';
}

function userIdsFromRows(rows: ParseRow[]): string[] {
  return Array.from(new Set(rows.map((row) => row.userId).filter(Boolean)));
}

function parseStateMatchCondition(expected: string | null) {
  return expected === null ? isNull(documents.parseState) : eq(documents.parseState, expected);
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
    const rows = await loadScopedRows(input);
    const ready = rows.find(isReadyRow);
    if (ready) {
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: [input.userId],
        parseState: stringifyDocumentParseState({
          status: 'ready',
          progress: null,
          updatedAt: Date.now(),
        }),
        parsedJsonKey: ready.parsedJsonKey,
      });
      return;
    }

    const statuses = rows.map((row) => parseDocumentParseState(row.parseState));
    const hasInFlight = statuses.some((state) => state.status === 'pending' || state.status === 'running');
    const failedState = statuses.find((state) => state.status === 'failed');
    if (failedState && !hasInFlight) {
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: [input.userId],
        parseState: stringifyDocumentParseState({
          status: 'failed',
          progress: null,
          updatedAt: Date.now(),
          ...(failedState.error ? { error: failedState.error } : {}),
        }),
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

  try {
    const scopedRows = await loadScopedRows(input);
    const scopedUserIds = userIdsFromRows(scopedRows);

    // Non-force jobs can short-circuit by reusing existing ready output from
    // any row in the same document scope.
    if (!input.forceToken?.trim()) {
      const ready = scopedRows.find(isReadyRow);
      if (ready) {
        await updateParseStateForUsers({
          documentId: input.documentId,
          userIds: [input.userId],
          parseState: stringifyDocumentParseState({
            status: 'ready',
            progress: null,
            updatedAt: Date.now(),
          }),
          parsedJsonKey: ready.parsedJsonKey,
        });
        return;
      }
    }

    const coordinator = [...scopedRows].sort((a, b) => a.userId.localeCompare(b.userId))[0];
    if (!coordinator) return;

    const claimOpId = randomUUID();
    const runningState = stringifyDocumentParseState({
      status: 'running',
      progress: null,
      updatedAt: Date.now(),
      opId: claimOpId,
    });

    const claimRows = (await db
      .update(documents)
      .set({
        parseState: runningState,
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
      parseState: runningState,
    });

    const compute = await getCompute();
    const writeProgress = async (progress: PdfLayoutProgress): Promise<void> => {
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: cohortUserIds,
        parseState: stringifyDocumentParseState({
          status: 'running',
          progress: {
            totalPages: progress.totalPages,
            pagesParsed: progress.pagesParsed,
            currentPage: progress.currentPage,
            phase: progress.phase,
          },
          updatedAt: Date.now(),
          opId: claimOpId,
        }),
      });
    };
    const layout = await compute.parsePdfLayout({
      documentId: input.documentId,
      namespace: input.namespace,
      documentObjectKey: documentKey(input.documentId, input.namespace),
      forceToken: input.forceToken,
      onProgress: writeProgress,
    });

    let parsedJsonKey = layout.parsedObjectKey ?? null;
    if (!parsedJsonKey) {
      if (!layout.parsed) throw new Error('Compute backend did not return parsed result');
      const parsedJson = Buffer.from(JSON.stringify(layout.parsed));
      parsedJsonKey = await putParsedDocumentBlob(input.documentId, parsedJson, input.namespace);
    }

    const finalScopedRows = await loadScopedRows(input);
    const finalUserIds = userIdsFromRows(finalScopedRows);
    await updateParseStateForUsers({
      documentId: input.documentId,
      userIds: finalUserIds.length > 0 ? finalUserIds : cohortUserIds,
      parseState: stringifyDocumentParseState({
        status: 'ready',
        progress: null,
        updatedAt: Date.now(),
      }),
      parsedJsonKey,
    });

    // Best-effort cache invalidation should not block parse readiness.
    for (const userId of (finalUserIds.length > 0 ? finalUserIds : cohortUserIds)) {
      void clearTtsSegmentCache({
        userId,
        documentId: input.documentId,
        readerType: 'pdf',
      }).then((cleared) => {
        if (cleared.warning) {
          console.warn('[parsePdfJob] cache invalidation warning', {
            documentId: input.documentId,
            userId,
            warning: cleared.warning,
          });
        }
      }).catch((cacheError) => {
        console.warn('[parsePdfJob] cache invalidation failed', {
          documentId: input.documentId,
          userId,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const cause = error instanceof Error ? error.cause : undefined;
    const parseStatus = 'failed';
    try {
      const scopedRows = await loadScopedRows(input);
      const scopedUserIds = userIdsFromRows(scopedRows);
      await updateParseStateForUsers({
        documentId: input.documentId,
        userIds: scopedUserIds.length > 0 ? scopedUserIds : [input.userId],
        parseState: stringifyDocumentParseState({
          status: 'failed',
          progress: null,
          updatedAt: Date.now(),
          error: message,
        }),
      });
    } catch (statusError) {
      console.error('[parsePdfJob] failed to write parse status', {
        documentId: input.documentId,
        parseStatus,
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
    }
    console.error('[parsePdfJob] failed', {
      documentId: input.documentId,
      parseStatus,
      error: message,
      ...(stack ? { stack } : {}),
      ...(cause ? { cause: String(cause) } : {}),
    });
  } finally {
    running.delete(key);
  }
}

export function enqueueParsePdfJob(input: UserPdfLayoutJobRequest): void {
  Promise.resolve()
    .then(() => parsePdfJob(input))
    .catch((error) => {
      console.error('[parsePdfJob] uncaught error', error);
    });
}
