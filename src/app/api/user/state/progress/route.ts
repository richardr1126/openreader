import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userDocumentProgress } from '@openreader/database/schema';
import type { ReaderType } from '@/types/user-state';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { coerceTimestampMs, nowTimestampMs } from '@/lib/shared/timestamps';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  normalizeEpubProgressLocator,
  parseEpubProgressLocator,
  serializeEpubProgressLocator,
} from '@/lib/shared/epub-progress';

export const dynamic = 'force-dynamic';

function normalizeReaderType(value: unknown): ReaderType | null {
  if (value === 'pdf' || value === 'epub' || value === 'html') return value;
  return null;
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

    const rows = await db
      .select({
        documentId: userDocumentProgress.documentId,
        readerType: userDocumentProgress.readerType,
        location: userDocumentProgress.location,
        progress: userDocumentProgress.progress,
        clientUpdatedAtMs: userDocumentProgress.clientUpdatedAtMs,
        updatedAt: userDocumentProgress.updatedAt,
      })
      .from(userDocumentProgress)
      .where(and(
        eq(userDocumentProgress.userId, scope.ownerUserId),
        eq(userDocumentProgress.documentId, documentId),
      ))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return NextResponse.json({ progress: null });
    }

    if (row.readerType === 'epub') {
      const locator = parseEpubProgressLocator(row.location);
      if (!locator) {
        return NextResponse.json({ progress: null, invalidated: true });
      }
      return NextResponse.json({
        progress: {
          documentId: row.documentId,
          readerType: 'epub',
          locator,
          progress: row.progress == null ? null : Number(row.progress),
          clientUpdatedAtMs: Number(row.clientUpdatedAtMs ?? 0),
          updatedAtMs: coerceTimestampMs(row.updatedAt, nowTimestampMs()),
        },
      });
    }

    return NextResponse.json({
      progress: {
        documentId: row.documentId,
        readerType: row.readerType,
        location: row.location,
        progress: row.progress == null ? null : Number(row.progress),
        clientUpdatedAtMs: Number(row.clientUpdatedAtMs ?? 0),
        updatedAtMs: coerceTimestampMs(row.updatedAt, nowTimestampMs()),
      },
    });
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
        readerType?: unknown;
        location?: unknown;
        locator?: unknown;
        progress?: unknown;
        clientUpdatedAtMs?: unknown;
      }
      | null;

    const documentId = typeof body?.documentId === 'string' ? body.documentId.trim().toLowerCase() : '';
    if (!isValidDocumentId(documentId)) {
      return NextResponse.json({ error: 'Invalid documentId' }, { status: 400 });
    }

    const readerType = normalizeReaderType(body?.readerType);
    if (!readerType) {
      return NextResponse.json({ error: "Invalid readerType. Expected 'pdf', 'epub', or 'html'." }, { status: 400 });
    }

    const locator = readerType === 'epub' ? normalizeEpubProgressLocator(body?.locator) : null;
    const location = readerType === 'epub'
      ? (locator ? serializeEpubProgressLocator(locator) : '')
      : (typeof body?.location === 'string' ? body.location.trim() : '');
    if (!location) return NextResponse.json({
      error: readerType === 'epub' ? 'Invalid EPUB progress locator' : 'Invalid location',
    }, { status: 400 });

    const progress =
      body?.progress == null
        ? null
        : Number.isFinite(body.progress)
          ? Math.max(0, Math.min(1, Number(body.progress)))
          : null;
    const clientUpdatedAtMs = normalizeClientUpdatedAtMs(body?.clientUpdatedAtMs);

    const existingRows = await db
      .select({
        clientUpdatedAtMs: userDocumentProgress.clientUpdatedAtMs,
        location: userDocumentProgress.location,
        readerType: userDocumentProgress.readerType,
        progress: userDocumentProgress.progress,
        updatedAt: userDocumentProgress.updatedAt,
      })
      .from(userDocumentProgress)
      .where(and(
        eq(userDocumentProgress.userId, scope.ownerUserId),
        eq(userDocumentProgress.documentId, documentId),
      ))
      .limit(1);
    const existing = existingRows[0];
    const existingUpdated = Number(existing?.clientUpdatedAtMs ?? 0);

    const responseProgress = (
      storedReaderType: string,
      storedLocation: string,
      storedProgress: number | null,
      storedClientUpdatedAtMs: number,
      storedUpdatedAtMs: number,
    ) => {
      if (storedReaderType === 'epub') {
        const storedLocator = parseEpubProgressLocator(storedLocation);
        return storedLocator ? {
          documentId,
          readerType: 'epub' as const,
          locator: storedLocator,
          progress: storedProgress,
          clientUpdatedAtMs: storedClientUpdatedAtMs,
          updatedAtMs: storedUpdatedAtMs,
        } : null;
      }
      return {
        documentId,
        readerType: storedReaderType,
        location: storedLocation,
        progress: storedProgress,
        clientUpdatedAtMs: storedClientUpdatedAtMs,
        updatedAtMs: storedUpdatedAtMs,
      };
    };

    if (existing && clientUpdatedAtMs < existingUpdated) {
      return NextResponse.json({
        progress: responseProgress(
          existing.readerType,
          existing.location,
          existing.progress == null ? null : Number(existing.progress),
          existingUpdated,
          coerceTimestampMs(existing.updatedAt, nowTimestampMs()),
        ),
        applied: false,
      });
    }

    const updatedAt = nowTimestampMs();
    await db
      .insert(userDocumentProgress)
      .values({
        userId: scope.ownerUserId,
        documentId,
        readerType,
        location,
        progress,
        clientUpdatedAtMs,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [userDocumentProgress.userId, userDocumentProgress.documentId],
        set: {
          readerType,
          location,
          progress,
          clientUpdatedAtMs,
          updatedAt,
        },
        setWhere: sql`${userDocumentProgress.clientUpdatedAtMs} <= ${clientUpdatedAtMs}`,
      });

    return NextResponse.json({
      progress: responseProgress(readerType, location, progress, clientUpdatedAtMs, updatedAt),
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
