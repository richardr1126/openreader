import { and, eq, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import type { ReaderType } from '@/types/user-state';

export type ResolvedSegmentDocumentScope = {
  testNamespace: string | null;
  storageUserId: string;
  userId: string;
  isAnonymousUser: boolean;
  documentVersion: number;
  readerType: ReaderType;
};

function toReaderType(documentType: string): ReaderType {
  if (documentType === 'pdf') return 'pdf';
  if (documentType === 'epub') return 'epub';
  return 'html';
}

export async function resolveSegmentDocumentScope(
  request: NextRequest,
  documentId: string,
): Promise<ResolvedSegmentDocumentScope | Response> {
  const ctxOrRes = await requireAuthContext(request);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const testNamespace = getOpenReaderTestNamespace(request.headers);
  const storageUserId = ctxOrRes.userId;
  const allowedUserIds = [storageUserId];

  const rows = (await db
    .select({
      userId: documents.userId,
      lastModified: documents.lastModified,
      type: documents.type,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), inArray(documents.userId, allowedUserIds)))) as Array<{
      userId: string;
      lastModified: number;
      type: string;
    }>;

  const doc = rows.find((row) => row.userId === storageUserId) ?? rows[0];
  if (!doc) {
    return Response.json({ error: 'Document not found' }, { status: 404 });
  }

  return {
    testNamespace,
    storageUserId: doc.userId,
    userId: ctxOrRes.userId,
    isAnonymousUser: Boolean(ctxOrRes.user?.isAnonymous),
    documentVersion: Number(doc.lastModified),
    readerType: toReaderType(doc.type),
  };
}
