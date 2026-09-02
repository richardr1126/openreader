import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documentSettings } from '@openreader/database/schema';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

/**
 * Resolve the persisted per-document `skipBlockKinds` (PDF) for a user, so the
 * worker-owned planner can derive the same source units the client would. Falls
 * back to the document-settings defaults when no row exists. Read server-side so
 * background generation does not depend on the client.
 */
export async function getDocumentSkipBlockKinds(
  documentId: string,
  userId: string,
): Promise<ParsedPdfBlockKind[]> {
  const [row] = (await db
    .select({ dataJson: documentSettings.dataJson })
    .from(documentSettings)
    .where(and(
      eq(documentSettings.documentId, documentId),
      eq(documentSettings.userId, userId),
    ))
    .limit(1)) as Array<{ dataJson: unknown }>;

  const merged = mergeDocumentSettings(undefined, row?.dataJson ?? null);
  return merged.pdf?.skipBlockKinds ?? [];
}
