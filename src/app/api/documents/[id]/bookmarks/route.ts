import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userDocumentBookmarks } from '@openreader/database/schema';
import { resolveOwnedDocumentAccess } from '@/lib/server/documents/access';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import {
  MAX_BOOKMARKS_PER_DOCUMENT,
  bookmarkSelection,
  parseBookmarkCreateBody,
  toDocumentBookmark,
  type BookmarkRow,
} from '@/lib/server/documents/bookmarks';
import { errorResponse } from '@/lib/server/errors/next-response';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { nowTimestampMs } from '@/lib/shared/timestamps';

export const dynamic = 'force-dynamic';

function documentIdFrom(id: string | undefined): string | null {
  const documentId = (id || '').trim().toLowerCase();
  return isValidDocumentId(documentId) ? documentId : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const documentId = documentIdFrom((await ctx.params).id);
    if (!documentId) return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });

    const scope = await resolveOwnedDocumentAccess(req, documentId);
    if (scope instanceof Response) return scope;

    const rows = (await db
      .select(bookmarkSelection)
      .from(userDocumentBookmarks)
      .where(and(
        eq(userDocumentBookmarks.userId, scope.ownerUserId),
        eq(userDocumentBookmarks.documentId, documentId),
      ))
      .orderBy(desc(userDocumentBookmarks.createdAt))) as BookmarkRow[];

    return NextResponse.json({ bookmarks: rows.map(toDocumentBookmark) });
  } catch (error) {
    serverLogger.error({
      event: 'documents.bookmarks.list.failed',
      error: errorToLog(error),
    }, 'Failed to load document bookmarks');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load bookmarks',
      normalize: { code: 'DOCUMENTS_BOOKMARKS_LIST_FAILED', errorClass: 'db' },
    });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const documentId = documentIdFrom((await ctx.params).id);
    if (!documentId) return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });

    const scope = await resolveOwnedDocumentAccess(req, documentId);
    if (scope instanceof Response) return scope;

    const parsed = parseBookmarkCreateBody(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parsed.value;

    const ownedBookmark = (id: string) => and(
      eq(userDocumentBookmarks.id, id),
      eq(userDocumentBookmarks.userId, scope.ownerUserId),
    );

    if (input.id) {
      const [existing] = (await db
        .select(bookmarkSelection)
        .from(userDocumentBookmarks)
        .where(ownedBookmark(input.id))
        .limit(1)) as BookmarkRow[];
      if (existing) {
        if (existing.documentId !== documentId) {
          return NextResponse.json({ error: 'Bookmark id already exists' }, { status: 409 });
        }
        return NextResponse.json({ bookmark: toDocumentBookmark(existing) });
      }
    }

    const [{ value: existingCount }] = await db
      .select({ value: count() })
      .from(userDocumentBookmarks)
      .where(and(
        eq(userDocumentBookmarks.userId, scope.ownerUserId),
        eq(userDocumentBookmarks.documentId, documentId),
      ));
    if (Number(existingCount) >= MAX_BOOKMARKS_PER_DOCUMENT) {
      return NextResponse.json({ error: 'This document has too many bookmarks' }, { status: 409 });
    }

    const id = input.id ?? randomUUID();
    const now = nowTimestampMs();
    await db
      .insert(userDocumentBookmarks)
      .values({
        id,
        userId: scope.ownerUserId,
        documentId,
        segmentKey: input.segmentKey,
        segmentOrdinal: input.segmentOrdinal,
        label: input.label,
        snippet: input.snippet,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const [stored] = (await db
      .select(bookmarkSelection)
      .from(userDocumentBookmarks)
      .where(ownedBookmark(id))
      .limit(1)) as BookmarkRow[];
    if (!stored || stored.documentId !== documentId) {
      return NextResponse.json({ error: 'Bookmark id already exists' }, { status: 409 });
    }
    return NextResponse.json({ bookmark: toDocumentBookmark(stored) }, { status: 201 });
  } catch (error) {
    serverLogger.error({
      event: 'documents.bookmarks.create.failed',
      error: errorToLog(error),
    }, 'Failed to create document bookmark');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to create bookmark',
      normalize: { code: 'DOCUMENTS_BOOKMARKS_CREATE_FAILED', errorClass: 'db' },
    });
  }
}
