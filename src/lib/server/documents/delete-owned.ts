import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { deleteDocumentBlob } from '@/lib/server/documents/blobstore';
import {
  cleanupDocumentPreviewArtifacts,
  deleteDocumentPreviewRows,
} from '@/lib/server/documents/previews';
import { deleteDocumentTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { withDocumentMutationLock } from '@/lib/server/documents/mutation-lock';

type DocumentRow = typeof documents.$inferSelect;

async function restoreDocumentOwnership(row: DocumentRow): Promise<void> {
  await db.insert(documents).values(row).onConflictDoNothing();
}

async function removeOwnershipAndCheckLastOwner(input: {
  userId: string;
  documentId: string;
}): Promise<{ removed: DocumentRow | null; isLastOwner: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;
  const runAsync = async (tx: typeof database) => {
    await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .for('update');

    const [removed] = await tx
      .delete(documents)
      .where(and(
        eq(documents.id, input.documentId),
        eq(documents.userId, input.userId),
      ))
      .returning();
    if (!removed) return { removed: null, isLastOwner: false };

    const otherOwners = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(
        eq(documents.id, input.documentId),
        ne(documents.userId, input.userId),
      ))
      .limit(1);
    return { removed, isLastOwner: otherOwners.length === 0 };
  };

  if (process.env.POSTGRES_URL) {
    return database.transaction(runAsync);
  }

  return database.transaction((tx: typeof database) => {
    const removed = tx
      .delete(documents)
      .where(and(
        eq(documents.id, input.documentId),
        eq(documents.userId, input.userId),
      ))
      .returning()
      .all()[0] ?? null;
    if (!removed) return { removed: null, isLastOwner: false };

    const otherOwners = tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(
        eq(documents.id, input.documentId),
        ne(documents.userId, input.userId),
      ))
      .limit(1)
      .all();
    return { removed, isLastOwner: otherOwners.length === 0 };
  }, { behavior: 'immediate' });
}

export async function deleteOwnedDocument(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
}): Promise<boolean> {
  return withDocumentMutationLock(input.documentId, async () => {
    const { removed, isLastOwner } = await removeOwnershipAndCheckLastOwner(input);
    if (!removed) return false;

    try {
      await deleteDocumentTtsSegmentCache(input);

      if (isLastOwner) {
        await cleanupDocumentPreviewArtifacts(input.documentId, input.namespace);
        await deleteDocumentPreviewRows(input.documentId, input.namespace);

        const [newOwner] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, input.documentId))
          .limit(1);
        if (!newOwner) {
          await deleteDocumentBlob(input.documentId, input.namespace);
        }
      }
    } catch (error) {
      await restoreDocumentOwnership(removed);
      throw error;
    }

    return true;
  });
}
