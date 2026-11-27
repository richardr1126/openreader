import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents, documentSettings, userPreferences } from '@openreader/database/schema';
import { mergeDocumentSettings, normalizeSkipKinds } from '@/lib/shared/document-settings';
import { defaultPdfSkipBlockKinds } from '@/types/document-settings';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

function storedRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * What a PDF skips: the book's own setting, else the user's saved preference,
 * else the default for when the PDF was added.
 */
export function resolvePdfSkipBlockKinds(
  bookSkipBlockKinds: ParsedPdfBlockKind[] | undefined,
  storedPreferences: Record<string, unknown>,
  createdAtMs: number | null | undefined,
): ParsedPdfBlockKind[] {
  if (bookSkipBlockKinds !== undefined) return bookSkipBlockKinds;
  const saved = storedPreferences.pdfSkipBlockKinds;
  return Array.isArray(saved) ? normalizeSkipKinds(saved) : defaultPdfSkipBlockKinds(createdAtMs);
}

/** When a document was added, or null when unknown. */
export async function documentCreatedAtMs(documentId: string, storageUserId: string): Promise<number | null> {
  const [row] = await db.select({ createdAt: documents.createdAt }).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, storageUserId))).limit(1);
  return row?.createdAt == null ? null : Number(row.createdAt);
}

/**
 * Resolve a PDF's persisted skip list for a user, so the worker-owned planner
 * derives the same source units the reader would. Read server-side so
 * background generation does not depend on the client.
 */
export async function getDocumentSkipBlockKinds(
  documentId: string,
  storageUserId: string,
  userId = storageUserId,
): Promise<ParsedPdfBlockKind[]> {
  const [[settingsRow], [preferencesRow], createdAtMs] = await Promise.all([
    db.select({ dataJson: documentSettings.dataJson }).from(documentSettings)
      .where(and(eq(documentSettings.documentId, documentId), eq(documentSettings.userId, storageUserId)))
      .limit(1) as Promise<Array<{ dataJson: unknown }>>,
    db.select({ dataJson: userPreferences.dataJson }).from(userPreferences)
      .where(eq(userPreferences.userId, userId)).limit(1) as Promise<Array<{ dataJson: unknown }>>,
    documentCreatedAtMs(documentId, storageUserId),
  ]);
  const book = mergeDocumentSettings(undefined, storedRecord(settingsRow?.dataJson));
  return resolvePdfSkipBlockKinds(book.pdf?.skipBlockKinds, storedRecord(preferencesRow?.dataJson), createdAtMs);
}
