import { NextRequest, NextResponse } from 'next/server';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth';
import { safeDocumentName, toDocumentTypeFromName } from '@/lib/server/documents-utils';
import {
  cleanupDocumentPreviewArtifacts,
  deleteDocumentPreviewRows,
  enqueueDocumentPreview,
} from '@/lib/server/document-previews';
import { deleteDocumentBlob, headDocumentBlob, isMissingBlobError, isValidDocumentId } from '@/lib/server/documents-blobstore';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/test-namespace';
import { isS3Configured } from '@/lib/server/s3';
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

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = ctxOrRes.userId ?? unclaimedUserId;

    const body = await req.json().catch(() => null);
    const documentsData = parseDocumentPayload(body);
    if (documentsData.length === 0) {
      return NextResponse.json({ error: 'No valid documents provided' }, { status: 400 });
    }

    const stored: BaseDocument[] = [];

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
        })
        .onConflictDoUpdate({
          target: [documents.id, documents.userId],
          set: {
            name: doc.name,
            type: doc.type,
            size: headSize,
            lastModified: doc.lastModified,
            filePath: doc.id,
          },
        });

      stored.push({
        id: doc.id,
        name: doc.name,
        type: doc.type,
        size: headSize,
        lastModified: doc.lastModified,
        scope: storageUserId === unclaimedUserId ? 'unclaimed' : 'user',
      });

      await enqueueDocumentPreview(
        {
          id: doc.id,
          type: doc.type,
          lastModified: doc.lastModified,
        },
        testNamespace,
      ).catch((error) => {
        console.error(`Failed to enqueue preview for document ${doc.id}:`, error);
      });
    }

    return NextResponse.json({ success: true, stored });
  } catch (error) {
    console.error('Error registering documents:', error);
    return NextResponse.json({ error: 'Failed to register documents' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = ctxOrRes.userId ?? unclaimedUserId;
    const allowedUserIds = ctxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

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
    }>;

    const results: BaseDocument[] = rows.map((doc) => {
      const type = normalizeDocumentType(doc.type, doc.name);
      return {
        id: doc.id,
        name: doc.name,
        size: Number(doc.size),
        lastModified: Number(doc.lastModified),
        type,
        scope: doc.userId === unclaimedUserId ? 'unclaimed' : 'user',
      };
    });

    return NextResponse.json({ documents: results });
  } catch (error) {
    console.error('Error loading document metadata:', error);
    return NextResponse.json({ error: 'Failed to load documents' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = ctxOrRes.userId ?? unclaimedUserId;

    const url = new URL(req.url);
    const idsParam = url.searchParams.get('ids');
    const scopeParam = (url.searchParams.get('scope') || '').toLowerCase().trim();

    const wantsUnclaimed = scopeParam === 'unclaimed';
    const wantsUser = scopeParam === '' || scopeParam === 'user';

    if (!wantsUser && !wantsUnclaimed) {
      return NextResponse.json(
        { error: "Invalid scope. Expected 'user' (default) or 'unclaimed'." },
        { status: 400 },
      );
    }

    if (ctxOrRes.authEnabled && wantsUnclaimed && ctxOrRes.user?.isAnonymous) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const targetUserIds = Array.from(
      new Set(
        [
          ...(wantsUser ? [storageUserId] : []),
          ...(wantsUnclaimed ? [unclaimedUserId] : []),
        ].filter(Boolean),
      ),
    );

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
          console.error(`[best-effort] Failed to delete blob for document ${id}, orphaned blob may need manual cleanup:`, error);
        }
      }

      await cleanupDocumentPreviewArtifacts(id, testNamespace).catch((error) => {
        console.error(`Failed to cleanup preview artifacts for document ${id}:`, error);
      });
      await deleteDocumentPreviewRows(id, testNamespace).catch((error) => {
        console.error(`Failed to cleanup preview rows for document ${id}:`, error);
      });
    }

    return NextResponse.json({ success: true, deleted: deletedRows.length });
  } catch (error) {
    console.error('Error deleting documents:', error);
    return NextResponse.json({ error: 'Failed to delete documents' }, { status: 500 });
  }
}
