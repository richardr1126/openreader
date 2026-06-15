import { and, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { documents, userFolders } from '@openreader/database/schema';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { name?: unknown; position?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : undefined;
    const position = Number.isFinite(body?.position) ? Number(body?.position) : undefined;
    if (!name && position === undefined) return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 });
    const rows = await db.update(userFolders).set({
      ...(name ? { name } : {}),
      ...(position !== undefined ? { position } : {}),
      updatedAt: nowTimestampMs(),
    }).where(and(eq(userFolders.id, id), eq(userFolders.userId, scope.ownerUserId))).returning();
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ folder: rows[0] });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to update folder',
      normalize: { code: 'FOLDER_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const { id } = await ctx.params;
    await db.update(documents).set({ folderId: null }).where(and(
      eq(documents.userId, scope.ownerUserId),
      eq(documents.folderId, id),
    ));
    await db.delete(userFolders).where(and(eq(userFolders.id, id), eq(userFolders.userId, scope.ownerUserId)));
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to delete folder',
      normalize: { code: 'FOLDER_DELETE_FAILED', errorClass: 'db' },
    });
  }
}
