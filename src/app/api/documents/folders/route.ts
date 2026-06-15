import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { documents, userFolders } from '@openreader/database/schema';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const body = (await req.json().catch(() => null)) as { documentIds?: unknown; folderId?: unknown } | null;
    const documentIds = Array.isArray(body?.documentIds)
      ? Array.from(new Set(body.documentIds.filter((id): id is string => typeof id === 'string')))
      : [];
    const folderId = body?.folderId === null ? null : typeof body?.folderId === 'string' ? body.folderId : undefined;
    if (documentIds.length === 0 || folderId === undefined) {
      return NextResponse.json({ error: 'documentIds and folderId are required' }, { status: 400 });
    }
    const owned = await db.select({ id: documents.id }).from(documents).where(and(
      eq(documents.userId, scope.ownerUserId),
      inArray(documents.id, documentIds),
    ));
    if (owned.length !== documentIds.length) return NextResponse.json({ error: 'One or more documents were not found' }, { status: 404 });
    if (folderId) {
      const folder = await db.select({ id: userFolders.id }).from(userFolders).where(and(
        eq(userFolders.userId, scope.ownerUserId),
        eq(userFolders.id, folderId),
      )).limit(1);
      if (!folder[0]) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    }
    await db.update(documents).set({ folderId }).where(and(
      eq(documents.userId, scope.ownerUserId),
      inArray(documents.id, documentIds),
    ));
    return NextResponse.json({ success: true, documentIds, folderId });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to move documents',
      normalize: { code: 'DOCUMENT_FOLDER_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}
