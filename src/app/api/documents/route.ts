import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { safeDocumentName, toDocumentTypeFromName } from '@/lib/server/documents/utils';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  cleanupDocumentPreviewArtifacts,
  deleteDocumentPreviewRows,
  enqueueDocumentPreview,
} from '@/lib/server/documents/previews';
import { enqueueParsePdfJob } from '@/lib/server/jobs/user-pdf-layout-job';
import { recordJobEvent, getPdfLayoutRateConfig } from '@/lib/server/rate-limit/job-rate-limiter';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { deleteDocumentBlob, headDocumentBlob, isMissingBlobError, isValidDocumentId } from '@/lib/server/documents/blobstore';
import {
  normalizeParseStatus,
  parseDocumentParseState,
  stringifyDocumentParseState,
} from '@/lib/server/documents/parse-state';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { BaseDocument, DocumentType } from '@/types/documents';

export const dynamic = 'force-dynamic';

type RegisterDocument = {
  id: string;
  name: string;
  type: DocumentType;
  size: number;
  lastModified: number;
};

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

function normalizeLastModified(value: unknown): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : Date.now();
}

function parseDocumentPayload(body: unknown): RegisterDocument[] {
  if (!body || typeof body !== 'object') return [];
  const rawDocs = (body as { documents?: unknown }).documents;
  if (!Array.isArray(rawDocs)) return [];

  const docs: RegisterDocument[] = [];
  for (const rawDoc of rawDocs) {
    if (!rawDoc || typeof rawDoc !== 'object') continue;
    const rec = rawDoc as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim().toLowerCase() : '';
    if (!isValidDocumentId(id)) continue;
    const fallbackName = `${id}.${typeof rec.type === 'string' ? rec.type : 'txt'}`;
    const name = safeDocumentName(typeof rec.name === 'string' ? rec.name : '', fallbackName);
    const type = normalizeDocumentType(rec.type, name);
    const lastModified = normalizeLastModified(rec.lastModified);
    const size = Number.isFinite(rec.size) && Number(rec.size) >= 0 ? Number(rec.size) : 0;
    docs.push({ id, name, type, size, lastModified });
  }
  return docs;
}

export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const storageUserId = ctxOrRes.userId;

    const body = await req.json().catch(() => null);
    const documentsData = parseDocumentPayload(body);
    if (documentsData.length === 0) {
      return NextResponse.json({ error: 'No valid documents provided' }, { status: 400 });
    }

    const stored: BaseDocument[] = [];

    // Resolve the parse rate-limit config once (only when a PDF is present).
    const pdfRateConfig = documentsData.some((doc) => doc.type === 'pdf')
      ? getPdfLayoutRateConfig(await getResolvedRuntimeConfig())
      : null;

    for (const doc of documentsData) {
      let headSize = doc.size;

      // Retry HEAD check to handle S3 read-after-write propagation delays.
      // The client uploads bytes directly to S3 via presigned URL, then
      // immediately calls this endpoint. On serverless platforms the HEAD
      // request may reach S3 before the PUT is visible.
      const HEAD_RETRIES = 3;
      const HEAD_RETRY_DELAY_MS = 500;
      let headError: unknown = null;
      for (let attempt = 0; attempt < HEAD_RETRIES; attempt++) {
        headError = null;
        try {
          const head = await headDocumentBlob(doc.id, testNamespace);
          if (head.contentLength > 0) headSize = head.contentLength;
          break;
        } catch (error) {
          if (isMissingBlobError(error)) {
            headError = error;
            if (attempt < HEAD_RETRIES - 1) {
              await new Promise((r) => setTimeout(r, HEAD_RETRY_DELAY_MS));
              continue;
            }
          } else {
            throw error;
          }
        }
      }
      if (headError && isMissingBlobError(headError)) {
        return NextResponse.json(
          {
            error: `Blob missing for document ${doc.id}. Upload bytes first using /api/documents/blob/upload/presign.`,
          },
          { status: 409 },
        );
      }

      await db
        .insert(documents)
        .values({
          id: doc.id,
          userId: storageUserId,
          name: doc.name,
          type: doc.type,
          size: headSize,
          lastModified: doc.lastModified,
          filePath: doc.id,
          parseState: doc.type === 'pdf'
            ? stringifyDocumentParseState({ status: 'pending', progress: null, updatedAt: Date.now() })
            : null,
          parsedJsonKey: null,
        })
        .onConflictDoUpdate({
          target: [documents.id, documents.userId],
          set: {
            name: doc.name,
            type: doc.type,
            size: headSize,
            lastModified: doc.lastModified,
            filePath: doc.id,
            parseState: doc.type === 'pdf'
              ? stringifyDocumentParseState({ status: 'pending', progress: null, updatedAt: Date.now() })
              : null,
            parsedJsonKey: null,
          },
        });

      stored.push({
        id: doc.id,
        name: doc.name,
        type: doc.type,
        size: headSize,
        lastModified: doc.lastModified,
        scope: 'user',
      });

      await enqueueDocumentPreview(
        {
          id: doc.id,
          type: doc.type,
          lastModified: doc.lastModified,
        },
        testNamespace,
      ).catch((error) => {
        serverLogger.warn({
          event: 'documents.preview.enqueue.failed',
          degraded: true,
          fallbackPath: 'skip_preview_enqueue',
          documentId: doc.id,
          error: errorToLog(error),
        }, 'Failed to enqueue document preview');
      });

      if (doc.type === 'pdf') {
        // Account for upload-driven parse load in the same ledger the explicit
        // re-parse limiter reads. We record (not reject) here so a legitimate
        // bulk upload always parses; the recorded load still throttles
        // subsequent loopable re-parse spam via /parsed.
        await recordJobEvent(ctxOrRes.userId, 'pdf_layout', `register:${randomUUID()}`, pdfRateConfig ?? { enabled: false, windows: [] });
        enqueueParsePdfJob({
          documentId: doc.id,
          userId: storageUserId,
          namespace: testNamespace,
        });
      }
    }

    return NextResponse.json({ success: true, stored });
  } catch (error) {
    serverLogger.error({
      event: 'documents.register.failed',
      error: errorToLog(error),
    }, 'Failed to register documents');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to register documents',
      normalize: { code: 'DOCUMENTS_REGISTER_FAILED', errorClass: 'db' },
    });
  }
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
      return {
        id: doc.id,
        name: doc.name,
        size: Number(doc.size),
        lastModified: Number(doc.lastModified),
        type,
        parseStatus: type === 'pdf' ? normalizeParseStatus(parseDocumentParseState(doc.parseState).status) : null,
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
