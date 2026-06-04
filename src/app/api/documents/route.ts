import { NextRequest, NextResponse } from 'next/server';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { toDocumentTypeFromName } from '@/lib/server/documents/utils';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  cleanupDocumentPreviewArtifacts,
  deleteDocumentPreviewRows,
} from '@/lib/server/documents/previews';
import { deleteDocumentBlob, isMissingBlobError, isValidDocumentId } from '@/lib/server/documents/blobstore';
import {
  normalizeDocumentParseStateForCurrentParserVersion,
  normalizeParseStatus,
  parseDocumentParseState,
} from '@/lib/server/documents/parse-state';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { BaseDocument, DocumentType } from '@/types/documents';

export const dynamic = 'force-dynamic';

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function normalizeDocumentType(rawType: unknown, safeName: string): DocumentType {
  if (rawType === 'pdf' || rawType === 'epub' || rawType === 'docx' || rawType === 'html') {
    return rawType;
  }
  return toDocumentTypeFromName(safeName);
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
    const rows = (await db.select().from(documents).where(and(...conditions))) as Array<{
      id: string;
      userId: string;
      name: string;
      type: string;
      size: number;
      lastModified: number;
      filePath: string;
      parseState: string | null;
      parsedJsonKey: string | null;
    }>;

    const results: BaseDocument[] = rows.map((doc) => {
      const type = normalizeDocumentType(doc.type, doc.name);
      const parseState = type === 'pdf'
        ? normalizeDocumentParseStateForCurrentParserVersion(parseDocumentParseState(doc.parseState))
        : null;
      return {
        id: doc.id,
        name: doc.name,
        size: Number(doc.size),
        lastModified: Number(doc.lastModified),
        type,
        parseStatus: type === 'pdf' && parseState ? normalizeParseStatus(parseState.status) : null,
        parsedJsonKey: doc.parsedJsonKey,
        scope: 'user',
      };
    });

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

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const storageUserId = ctxOrRes.userId;

    const url = new URL(req.url);
    const idsParam = url.searchParams.get('ids');
    const scopeParam = (url.searchParams.get('scope') || '').toLowerCase().trim();
    if (scopeParam && scopeParam !== 'user') {
      return NextResponse.json({ error: "Invalid scope. Expected 'user' (default)." }, { status: 400 });
    }

    const targetUserIds = [storageUserId];

    if (targetUserIds.length === 0) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

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

    const deletedRows = (await db
      .delete(documents)
      .where(and(inArray(documents.userId, targetUserIds), inArray(documents.id, targetIds)))
      .returning({ id: documents.id })) as Array<{ id: string }>;

    const uniqueIds = Array.from(new Set(deletedRows.map((row) => row.id)));
    for (const id of uniqueIds) {
      const [ref] = await db.select({ count: count() }).from(documents).where(eq(documents.id, id));
      const refCount = Number(ref?.count ?? 0);
      if (refCount > 0) continue;

      try {
        await deleteDocumentBlob(id, testNamespace);
      } catch (error) {
        if (!isMissingBlobError(error)) {
          serverLogger.warn({
            event: 'documents.delete.blob_cleanup_failed',
            degraded: true,
            step: 'delete_document_blob',
            documentId: id,
            error: errorToLog(error),
          }, 'Failed to delete document blob during cleanup');
        }
      }

      await cleanupDocumentPreviewArtifacts(id, testNamespace).catch((error) => {
        serverLogger.warn({
          event: 'documents.delete.preview_artifacts_cleanup_failed',
          degraded: true,
          step: 'delete_preview_artifacts',
          documentId: id,
          error: errorToLog(error),
        }, 'Failed to cleanup preview artifacts');
      });
      await deleteDocumentPreviewRows(id, testNamespace).catch((error) => {
        serverLogger.warn({
          event: 'documents.delete.preview_rows_cleanup_failed',
          degraded: true,
          step: 'delete_preview_rows',
          documentId: id,
          error: errorToLog(error),
        }, 'Failed to cleanup preview rows');
      });
    }

    return NextResponse.json({ success: true, deleted: deletedRows.length });
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
