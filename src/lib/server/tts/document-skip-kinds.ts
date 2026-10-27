import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documentSettings, userPreferences } from '@openreader/database/schema';
import { mergeDocumentSettings, normalizeSkipKinds } from '@/lib/shared/document-settings';
import { DEFAULT_PDF_SKIP_BLOCK_KINDS } from '@/types/document-settings';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

/**
 * Resolve the persisted per-document `skipBlockKinds` (PDF) for a user, so the
 * worker-owned planner can derive the same source units the client would. Falls
 * back to the caller's PDF defaults when no override exists. Read server-side so
 * background generation does not depend on the client.
 */
export async function getDocumentSkipBlockKinds(
  documentId: string,
  storageUserId: string,
  userId = storageUserId,
): Promise<ParsedPdfBlockKind[]> {
  const [row] = (await db
    .select({ dataJson: documentSettings.dataJson })
    .from(documentSettings)
    .where(and(
      eq(documentSettings.documentId, documentId),
      eq(documentSettings.userId, storageUserId),
    ))
    .limit(1)) as Array<{ dataJson: unknown }>;

  const storedRecord = (value: unknown): Record<string, unknown> => {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };
  const merged = mergeDocumentSettings(undefined, storedRecord(row?.dataJson));
  if (merged.pdf?.skipBlockKinds !== undefined) return merged.pdf.skipBlockKinds;
  const [preferences] = await db.select({ dataJson: userPreferences.dataJson }).from(userPreferences)
    .where(eq(userPreferences.userId, userId)).limit(1);
  const defaults = storedRecord(preferences?.dataJson).pdfSkipBlockKinds;
  return Array.isArray(defaults) ? normalizeSkipKinds(defaults) : [...DEFAULT_PDF_SKIP_BLOCK_KINDS];
}
