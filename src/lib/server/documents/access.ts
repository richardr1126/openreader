import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';

/**
 * Authenticate the request and confirm the session user owns `documentId`.
 * Returns the owning user id and stored document type, or a 401/404 response to return as-is.
 */
export async function resolveOwnedDocumentAccess(
  req: NextRequest,
  documentId: string,
): Promise<{ ownerUserId: string; documentType: string } | Response> {
  const authCtxOrRes = await requireAuthContext(req);
  if (authCtxOrRes instanceof Response) return authCtxOrRes;
  if (!authCtxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select({ userId: documents.userId, type: documents.type })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, authCtxOrRes.userId)))
    .limit(1);

  if (!rows[0]) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return { ownerUserId: rows[0].userId, documentType: rows[0].type };
}
