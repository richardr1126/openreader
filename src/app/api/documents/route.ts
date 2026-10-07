import { after, NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents, userDocumentProgress } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { isS3Configured } from '@/lib/server/storage/s3';
import { deleteOwnedDocument } from '@/lib/server/documents/delete-owned';
import { toBaseDocument, type StoredDocumentRow } from '@/lib/server/documents/document-row';
import type { BaseDocument } from '@/types/documents';

export const dynamic = 'force-dynamic';

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

export async function GET(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;
    const allowedUserIds = [storageUserId];

    const url = new URL(req.url);
    const idsParam = url.searchParams.get('ids');
    const targetIds = idsParam
      ? idsParam
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => isValidDocumentId(id))
      : null;

    if (idsParam && (!targetIds || targetIds.length === 0)) {
      return NextResponse.json({ documents: [] });
    }

    const conditions = [
      inArray(documents.userId, allowedUserIds),
      ...(targetIds && targetIds.length > 0 ? [inArray(documents.id, targetIds)] : []),
    ];
    // One query: the progress row (if any) is the reading-status signal.
    const rows = (await db
      .select({
        id: documents.id,
        name: documents.name,
        type: documents.type,
        size: documents.size,
        lastModified: documents.lastModified,
        folderId: documents.folderId,
        recentlyOpenedAt: documents.recentlyOpenedAt,
        author: documents.author,
        language: documents.language,
        progress: userDocumentProgress.progress,
        progressUpdatedAt: userDocumentProgress.updatedAt,
        hasProgress: userDocumentProgress.documentId,
      })
      .from(documents)
      .leftJoin(userDocumentProgress, and(
        eq(userDocumentProgress.userId, documents.userId),
        eq(userDocumentProgress.documentId, documents.id),
      ))
      .where(and(...conditions))) as Array<StoredDocumentRow & {
      progress: number | null;
      progressUpdatedAt: number | null;
      hasProgress: string | null;
    }>;

    const results: BaseDocument[] = rows.map((row) => toBaseDocument(
      row,
      row.hasProgress ? { progress: row.progress, updatedAt: row.progressUpdatedAt } : null,
    ));

    return NextResponse.json({ documents: results });
  } catch (error) {
    serverLogger.error({
      event: 'documents.list.failed',
      error: errorToLog(error),
    }, 'Failed to load document metadata');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load documents',
      normalize: { code: 'DOCUMENTS_LIST_FAILED', errorClass: 'db' },
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;

    const url = new URL(req.url);
    const idsParam = url.searchParams.get('ids');
    const scopeParam = (url.searchParams.get('scope') || '').toLowerCase().trim();
    if (scopeParam && scopeParam !== 'user') {
      return NextResponse.json({ error: "Invalid scope. Expected 'user' (default)." }, { status: 400 });
    }

    const targetUserIds = [storageUserId];

    let targetIds: string[] = [];
    if (idsParam) {
      targetIds = idsParam
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => isValidDocumentId(id));
    } else {
      const rows = (await db
        .select({ id: documents.id })
        .from(documents)
        .where(inArray(documents.userId, targetUserIds))) as Array<{ id: string }>;
      targetIds = rows.map((row) => row.id);
    }

    if (targetIds.length === 0) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    const ownedRows = (await db
      .select({ id: documents.id, userId: documents.userId })
      .from(documents)
      .where(and(inArray(documents.userId, targetUserIds), inArray(documents.id, targetIds)))) as Array<{
      id: string;
      userId: string;
    }>;

    let deleted = 0;
    for (const row of ownedRows) {
      if (await deleteOwnedDocument({
        userId: row.userId,
        documentId: row.id,
        namespace: null,
        scheduleCleanup: after,
      })) {
        deleted += 1;
      }
    }

    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    serverLogger.error({
      event: 'documents.delete.failed',
      error: errorToLog(error),
    }, 'Failed to delete documents');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to delete documents',
      normalize: { code: 'DOCUMENTS_DELETE_FAILED', errorClass: 'db' },
    });
  }
}
