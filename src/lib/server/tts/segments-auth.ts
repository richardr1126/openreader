import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import type { ReaderType } from '@/types/user-state';

export type ResolvedSegmentDocumentScope = {
  storageUserId: string;
  userId: string;
  isAnonymousUser: boolean;
  documentVersion: number;
  readerType: ReaderType;
  documentName: string;
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

  const scope = await resolveUserDocumentScope({
    userId: ctxOrRes.userId,
    isAnonymous: Boolean(ctxOrRes.user?.isAnonymous),
  }, documentId);
  return scope ?? Response.json({ error: 'Document not found' }, { status: 404 });
}

export async function resolveUserDocumentScope(
  owner: { userId: string; isAnonymous: boolean },
  documentId: string,
): Promise<ResolvedSegmentDocumentScope | null> {
  const rows = (await db
    .select({
      userId: documents.userId,
      lastModified: documents.lastModified,
      type: documents.type,
      name: documents.name,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, owner.userId)))) as Array<{
      userId: string;
      lastModified: number;
      type: string;
      name: string;
    }>;

  const doc = rows[0];
  if (!doc) return null;

  return {
    storageUserId: doc.userId,
    userId: owner.userId,
    isAnonymousUser: owner.isAnonymous,
    documentVersion: Number(doc.lastModified),
    readerType: toReaderType(doc.type),
    documentName: doc.name,
  };
}
