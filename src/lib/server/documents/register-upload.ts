import { db } from '@openreader/database';
import { documents, userFolders } from '@openreader/database/schema';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  enqueueDocumentPreview,
} from '@/lib/server/documents/previews';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { deleteDocumentTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import type { BaseDocument, DocumentType } from '@/types/documents';
import { withStorageRegistration } from '@/lib/server/storage/usage';

type RegisterUploadedDocumentInput = {
  documentId: string;
  userId: string;
  namespace: string | null;
  name: string;
  type: DocumentType;
  size: number;
  lastModified: number;
  folderId?: string | null;
  /** Import metadata; a null keeps whatever an earlier import of the same document stored. */
  author?: string | null;
  language?: string | null;
  schedulePreview?: (task: () => Promise<void>) => void;
};

/**
 * The folder ID as it stands when the row is written: a folder deleted after
 * verifyUploadFolder unfiles the document instead of failing the foreign key.
 */
export function existingFolderId(folderId: string | null, userId: string): SQL | null {
  if (!folderId) return null;
  return sql`(select ${userFolders.id} from ${userFolders} where ${userFolders.id} = ${folderId} and ${userFolders.userId} = ${userId})`;
}

export async function registerUploadedDocument(input: RegisterUploadedDocumentInput): Promise<BaseDocument> {
  const [existing] = await db
    .select({ lastModified: documents.lastModified })
    .from(documents)
    .where(and(
      eq(documents.id, input.documentId),
      eq(documents.userId, input.userId),
    ))
    .limit(1);

  if (existing && Number(existing.lastModified) !== input.lastModified) {
    await deleteDocumentTtsSegmentCache({
      userId: input.userId,
      documentId: input.documentId,
      namespace: input.namespace,
    });
  }

  const [storedDocument] = await withStorageRegistration(input, async (connection) => connection
    .insert(documents)
    .values({
      id: input.documentId,
      userId: input.userId,
      name: input.name,
      type: input.type,
      size: input.size,
      lastModified: input.lastModified,
      filePath: input.documentId,
      folderId: existingFolderId(input.folderId ?? null, input.userId),
      author: input.author ?? null,
      language: input.language ?? null,
    })
    .onConflictDoUpdate({
      target: [documents.id, documents.userId],
      set: {
        name: input.name,
        type: input.type,
        size: input.size,
        lastModified: input.lastModified,
        filePath: input.documentId,
        ...(input.folderId !== undefined ? { folderId: existingFolderId(input.folderId, input.userId) } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.language ? { language: input.language } : {}),
      },
    })
    .returning({ folderId: documents.folderId, author: documents.author, language: documents.language }));

  const enqueuePreview = async () => {
    await enqueueDocumentPreview(
      {
        id: input.documentId,
        userId: input.userId,
        type: input.type,
        lastModified: input.lastModified,
      },
      input.namespace,
    ).catch((error) => {
      serverLogger.warn({
        event: 'documents.preview.enqueue.failed',
        degraded: true,
        fallbackPath: 'skip_preview_enqueue',
        documentId: input.documentId,
        error: errorToLog(error),
      }, 'Failed to enqueue document preview');
    });
  };
  if (input.schedulePreview) {
    input.schedulePreview(enqueuePreview);
  } else {
    await enqueuePreview();
  }

  return {
    id: input.documentId,
    name: input.name,
    type: input.type,
    size: input.size,
    lastModified: input.lastModified,
    scope: 'user',
    folderId: storedDocument?.folderId ?? undefined,
    ...(storedDocument?.author ? { author: storedDocument.author } : {}),
    ...(storedDocument?.language ? { language: storedDocument.language } : {}),
  };
}
