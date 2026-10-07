import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userDocumentBookmarks } from '@openreader/database/schema';
import { resolveOwnedDocumentAccess } from '@/lib/server/documents/access';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import {
  bookmarkSelection,
  isValidBookmarkId,
  normalizeBookmarkLabel,
  toDocumentBookmark,
  type BookmarkRow,
} from '@/lib/server/documents/bookmarks';
import { errorResponse } from '@/lib/server/errors/next-response';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { nowTimestampMs } from '@/lib/shared/timestamps';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; bookmarkId: string }> };

async function resolveTarget(req: NextRequest, ctx: RouteContext) {
  const params = await ctx.params;
  const documentId = (params.id || '').trim().toLowerCase();
  const bookmarkId = (params.bookmarkId || '').trim().toLowerCase();
  if (!isValidDocumentId(documentId)) {
    return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
  }
  if (!isValidBookmarkId(bookmarkId)) {
    return NextResponse.json({ error: 'Invalid bookmark id' }, { status: 400 });
  }
  const scope = await resolveOwnedDocumentAccess(req, documentId);
  if (scope instanceof Response) return scope;
  return {
    bookmarkId,
    where: and(
      eq(userDocumentBookmarks.id, bookmarkId),
      eq(userDocumentBookmarks.userId, scope.ownerUserId),
      eq(userDocumentBookmarks.documentId, documentId),
    ),
  };
}

/** Renames a bookmark. Body: `{ label: string | null }`; null or blank clears it. */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const target = await resolveTarget(req, ctx);
    if (target instanceof Response) return target;

    const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
    const label = normalizeBookmarkLabel(body?.label);
    if (label === false || label === undefined) {
      return NextResponse.json({ error: 'Invalid label' }, { status: 400 });
    }

    const [updated] = (await db
      .update(userDocumentBookmarks)
      .set({ label, updatedAt: nowTimestampMs() })
      .where(target.where)
      .returning(bookmarkSelection)) as BookmarkRow[];
    const bookmark = updated ? toDocumentBookmark(updated) : null;
    if (!bookmark) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ bookmark });
  } catch (error) {
    serverLogger.error({
      event: 'documents.bookmarks.update.failed',
      error: errorToLog(error),
    }, 'Failed to update document bookmark');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to update bookmark',
      normalize: { code: 'DOCUMENTS_BOOKMARKS_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}

/** Hard-deletes a bookmark. Idempotent: `{ deleted: false }` when it was already gone. */
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  try {
    const target = await resolveTarget(req, ctx);
    if (target instanceof Response) return target;

    const removed = await db
      .delete(userDocumentBookmarks)
      .where(target.where)
      .returning({ id: userDocumentBookmarks.id });
    return NextResponse.json({ deleted: removed.length > 0 });
  } catch (error) {
    serverLogger.error({
      event: 'documents.bookmarks.delete.failed',
      error: errorToLog(error),
    }, 'Failed to delete document bookmark');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to delete bookmark',
      normalize: { code: 'DOCUMENTS_BOOKMARKS_DELETE_FAILED', errorClass: 'db' },
    });
  }
}
