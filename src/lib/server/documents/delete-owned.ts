import { and, eq, ne } from 'drizzle-orm';
import { documents } from '@/db/schema';
import { deleteDocumentBlob } from '@/lib/server/documents/blobstore';
import {
  cleanupDocumentPreviewArtifacts,
  deleteDocumentPreviewRows,
} from '@/lib/server/documents/previews';
import { deleteDocumentTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { withDocumentLock } from '@/lib/server/documents/document-lock';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

type DocumentRow = typeof documents.$inferSelect;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function restoreDocumentOwnership(conn: any, row: DocumentRow): Promise<void> {
  await conn.insert(documents).values(row).onConflictDoNothing();
}

async function removeOwnershipAndCheckLastOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any,
  input: { userId: string; documentId: string },
): Promise<{ removed: DocumentRow | null; isLastOwner: boolean }> {
  const [removed] = await conn
    .delete(documents)
    .where(and(
      eq(documents.id, input.documentId),
      eq(documents.userId, input.userId),
    ))
    .returning();
  if (!removed) return { removed: null, isLastOwner: false };

  const otherOwners = await conn
    .select({ id: documents.id })
    .from(documents)
    .where(and(
      eq(documents.id, input.documentId),
      ne(documents.userId, input.userId),
    ))
    .limit(1);
  return { removed, isLastOwner: otherOwners.length === 0 };
}

export async function deleteOwnedDocument(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
}): Promise<boolean> {
  return withDocumentLock(input.documentId, async (conn) => {
    const { removed, isLastOwner } = await removeOwnershipAndCheckLastOwner(conn, input);
    if (!removed) return false;

    try {
      await deleteDocumentTtsSegmentCache(input);

      if (isLastOwner) {
        await cleanupDocumentPreviewArtifacts(input.documentId, input.namespace);
        await deleteDocumentPreviewRows(input.documentId, input.namespace);

        const [newOwner] = await conn
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, input.documentId))
          .limit(1);
        if (!newOwner) {
          await deleteDocumentBlob(input.documentId, input.namespace);
        }
      }
    } catch (error) {
      // Best-effort rollback; never let a restore failure mask the original error.
      try {
        await restoreDocumentOwnership(conn, removed);
      } catch (restoreError) {
        logDegraded(serverLogger, {
          event: 'documents.delete_owned.restore_ownership.failed',
          msg: 'Failed to restore document ownership after deletion failure',
          step: 'restore_document_ownership',
          context: {
            documentId: input.documentId,
            userIdHash: hashForLog(input.userId),
          },
          error: restoreError,
        });
      }
      throw error;
    }

    return true;
  });
}
