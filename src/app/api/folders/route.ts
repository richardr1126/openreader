import { and, asc, eq, inArray } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { documents, userFolders } from '@openreader/database/schema';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const rows = await db.select().from(userFolders)
      .where(eq(userFolders.userId, scope.ownerUserId))
      .orderBy(asc(userFolders.position), asc(userFolders.createdAt));
    return NextResponse.json({ folders: rows });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load folders',
      normalize: { code: 'FOLDERS_LOAD_FAILED', errorClass: 'db' },
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const body = (await req.json().catch(() => null)) as { id?: unknown; name?: unknown; documentIds?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : '';
    if (!name) return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
    const documentIds = Array.isArray(body?.documentIds)
      ? Array.from(new Set(body.documentIds.filter((id): id is string => typeof id === 'string')))
      : [];
    if (documentIds.length > 0) {
      const owned = await db.select({ id: documents.id }).from(documents).where(and(
        eq(documents.userId, scope.ownerUserId),
        inArray(documents.id, documentIds),
      ));
      if (owned.length !== documentIds.length) {
        return NextResponse.json({ error: 'One or more documents were not found' }, { status: 404 });
      }
    }
    const id = typeof body?.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(body.id)
      ? body.id
      : crypto.randomUUID();
    const now = nowTimestampMs();
    await runInDbTransaction(async (tx) => {
      await tx.insert(userFolders).values({ id, userId: scope.ownerUserId, name, position: now, createdAt: now, updatedAt: now });
      if (documentIds.length > 0) {
        await tx.update(documents).set({ folderId: id }).where(and(
          eq(documents.userId, scope.ownerUserId),
          inArray(documents.id, documentIds),
        ));
      }
    });
    return NextResponse.json({ folder: { id, userId: scope.ownerUserId, name, position: now, createdAt: now, updatedAt: now } });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to create folder',
      normalize: { code: 'FOLDER_CREATE_FAILED', errorClass: 'db' },
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    await runInDbTransaction(async (tx) => {
      await tx.update(documents).set({ folderId: null }).where(eq(documents.userId, scope.ownerUserId));
      await tx.delete(userFolders).where(eq(userFolders.userId, scope.ownerUserId));
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to delete folders',
      normalize: { code: 'FOLDERS_DELETE_FAILED', errorClass: 'db' },
    });
  }
}
