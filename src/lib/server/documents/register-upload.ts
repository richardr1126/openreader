import { db } from '@/db';
import { documents } from '@/db/schema';
import {
  enqueueDocumentPreview,
} from '@/lib/server/documents/previews';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import type { BaseDocument, DocumentType } from '@/types/documents';

type RegisterUploadedDocumentInput = {
  documentId: string;
  userId: string;
  namespace: string | null;
  name: string;
  type: DocumentType;
  size: number;
  lastModified: number;
};

export async function registerUploadedDocument(input: RegisterUploadedDocumentInput): Promise<BaseDocument> {
  await db
    .insert(documents)
    .values({
      id: input.documentId,
      userId: input.userId,
      name: input.name,
      type: input.type,
      size: input.size,
      lastModified: input.lastModified,
      filePath: input.documentId,
    })
    .onConflictDoUpdate({
      target: [documents.id, documents.userId],
      set: {
        name: input.name,
        type: input.type,
        size: input.size,
        lastModified: input.lastModified,
        filePath: input.documentId,
      },
    });

  await enqueueDocumentPreview(
    {
      id: input.documentId,
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

  return {
    id: input.documentId,
    name: input.name,
    type: input.type,
    size: input.size,
    lastModified: input.lastModified,
    scope: 'user',
  };
}
