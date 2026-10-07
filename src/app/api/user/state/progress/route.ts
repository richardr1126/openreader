import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userDocumentProgress } from '@openreader/database/schema';
import type { DocumentProgressRecord } from '@/types/user-state';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { coerceTimestampMs, nowTimestampMs } from '@/lib/shared/timestamps';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { parseReadingPositionInput } from '@/lib/shared/reading-position';

export const dynamic = 'force-dynamic';

const progressSelection = {
  documentId: userDocumentProgress.documentId,
  segmentKey: userDocumentProgress.segmentKey,
  segmentOrdinal: userDocumentProgress.segmentOrdinal,
  progress: userDocumentProgress.progress,
  clientUpdatedAtMs: userDocumentProgress.clientUpdatedAtMs,
  updatedAt: userDocumentProgress.updatedAt,
};

type ProgressRow = {
  documentId: string;
  segmentKey: string | null;
  segmentOrdinal: number;
  progress: number | null;
  clientUpdatedAtMs: number | null;
  updatedAt: number | null;
};

function toProgressRecord(row: ProgressRow): DocumentProgressRecord {
  return {
    documentId: row.documentId,
    segmentKey: row.segmentKey ?? null,
    segmentOrdinal: Number(row.segmentOrdinal ?? 0),
    progress: row.progress == null ? null : Number(row.progress),
    clientUpdatedAtMs: Number(row.clientUpdatedAtMs ?? 0),
    updatedAtMs: coerceTimestampMs(row.updatedAt, nowTimestampMs()),
  };
}

function normalizeClientUpdatedAtMs(value: unknown): number {
  const normalized = coerceTimestampMs(value, nowTimestampMs());
  if (normalized <= 0) return nowTimestampMs();
  return normalized;
}

export async function GET(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;

    const documentId = (new URL(req.url).searchParams.get('documentId') || '').trim().toLowerCase();
    if (!isValidDocumentId(documentId)) {
      return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
    }

    const rows = (await db
      .select(progressSelection)
      .from(userDocumentProgress)
      .where(and(
        eq(userDocumentProgress.userId, scope.ownerUserId),
        eq(userDocumentProgress.documentId, documentId),
      ))
      .limit(1)) as ProgressRow[];

    const row = rows[0];
    return NextResponse.json({ progress: row ? toProgressRecord(row) : null });
  } catch (error) {
    serverLogger.error({
      event: 'user.progress.load.failed',
      error: errorToLog(error),
    }, 'Failed to load user progress');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load user progress',
      normalize: { code: 'USER_PROGRESS_LOAD_FAILED', errorClass: 'db' },
    });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;

    const body = (await req.json().catch(() => null)) as
      | {
        documentId?: unknown;
        segmentKey?: unknown;
        segmentOrdinal?: unknown;
        progress?: unknown;
        clientUpdatedAtMs?: unknown;
      }
      | null;

    const documentId = typeof body?.documentId === 'string' ? body.documentId.trim().toLowerCase() : '';
    if (!isValidDocumentId(documentId)) {
      return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
    }

    const position = parseReadingPositionInput(body);
    if (!position) {
      return NextResponse.json({ error: 'Invalid reading position' }, { status: 400 });
    }

    const progress =
      body?.progress == null
        ? null
        : Number.isFinite(body.progress)
          ? Math.max(0, Math.min(1, Number(body.progress)))
          : null;
    const clientUpdatedAtMs = normalizeClientUpdatedAtMs(body?.clientUpdatedAtMs);

    const existingRows = (await db
      .select(progressSelection)
      .from(userDocumentProgress)
      .where(and(
        eq(userDocumentProgress.userId, scope.ownerUserId),
        eq(userDocumentProgress.documentId, documentId),
      ))
      .limit(1)) as ProgressRow[];
    const existing = existingRows[0];

    if (existing && clientUpdatedAtMs < Number(existing.clientUpdatedAtMs ?? 0)) {
      return NextResponse.json({ progress: toProgressRecord(existing), applied: false });
    }

    const updatedAt = nowTimestampMs();
    await db
      .insert(userDocumentProgress)
      .values({
        userId: scope.ownerUserId,
        documentId,
        segmentKey: position.segmentKey,
        segmentOrdinal: position.segmentOrdinal,
        progress,
        clientUpdatedAtMs,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [userDocumentProgress.userId, userDocumentProgress.documentId],
        set: {
          segmentKey: position.segmentKey,
          segmentOrdinal: position.segmentOrdinal,
          progress,
          clientUpdatedAtMs,
          updatedAt,
        },
        setWhere: sql`${userDocumentProgress.clientUpdatedAtMs} <= ${clientUpdatedAtMs}`,
      });

    return NextResponse.json({
      progress: toProgressRecord({
        documentId,
        ...position,
        progress,
        clientUpdatedAtMs,
        updatedAt,
      }),
      applied: true,
    });
  } catch (error) {
    serverLogger.error({
      event: 'user.progress.update.failed',
      error: errorToLog(error),
    }, 'Failed to update user progress');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to update user progress',
      normalize: { code: 'USER_PROGRESS_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}
