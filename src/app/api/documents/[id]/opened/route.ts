import { and, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { errorResponse } from '@/lib/server/errors/next-response';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const { id } = await ctx.params;
    const recentlyOpenedAt = nowTimestampMs();
    const rows = await db.update(documents).set({ recentlyOpenedAt }).where(and(
      eq(documents.userId, scope.ownerUserId),
      eq(documents.id, id.toLowerCase()),
    )).returning({ id: documents.id });
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ documentId: rows[0].id, recentlyOpenedAt });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to update recently opened state',
      normalize: { code: 'DOCUMENT_OPENED_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}
