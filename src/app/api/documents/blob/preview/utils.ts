import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { isPreviewableDocumentType } from '@/lib/server/documents/previews';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';

export function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

export type ValidatedPreviewRequest = {
  doc: {
    id: string;
    userId: string;
    type: string;
    lastModified: number;
  };
  testNamespace: string | null;
  id: string;
  errorResponse?: undefined;
} | {
  doc?: undefined;
  testNamespace?: undefined;
  id?: undefined;
  errorResponse: NextResponse | Response;
};

export async function validatePreviewRequest(req: NextRequest): Promise<ValidatedPreviewRequest> {
  if (!isS3Configured()) return { errorResponse: s3NotConfiguredResponse() };

  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return { errorResponse: ctxOrRes };

  const testNamespace = getOpenReaderTestNamespace(req.headers);
  const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
  const storageUserId = ctxOrRes.userId ?? unclaimedUserId;

  // Deduplicate allowedUserIds
  const allowedUserIds = Array.from(new Set(
    ctxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId]
  ));

  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim().toLowerCase();

  if (!isValidDocumentId(id)) {
    return { errorResponse: NextResponse.json({ error: 'Invalid id' }, { status: 400 }) };
  }

  const rows = (await db
    .select({
      id: documents.id,
      userId: documents.userId,
      type: documents.type,
      lastModified: documents.lastModified,
    })
    .from(documents)
    .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
      type: string;
      lastModified: number;
    }>;

  const doc = rows.find((row) => row.userId === storageUserId) ?? rows[0];

  if (!doc) {
    return { errorResponse: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }

  if (!isPreviewableDocumentType(doc.type)) {
    return { errorResponse: NextResponse.json({ error: `Preview not supported for type ${doc.type}` }, { status: 415 }) };
  }

  return {
    doc,
    testNamespace,
    id
  };
}
