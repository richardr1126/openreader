import type { BaseDocument, DocumentType } from '@/types/documents';
import { toDocumentTypeFromName } from '@/lib/server/documents/utils';

export type StoredDocumentRow = {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  folderId: string | null;
  recentlyOpenedAt: number | null;
  author: string | null;
  language: string | null;
};

export type StoredProgressSummary = {
  progress: number | null;
  updatedAt: number | null;
} | null;

function normalizeDocumentType(rawType: unknown, name: string): DocumentType {
  if (rawType === 'pdf' || rawType === 'epub' || rawType === 'docx' || rawType === 'html') {
    return rawType;
  }
  return toDocumentTypeFromName(name);
}

/** The one mapping from a `documents` row (plus optional progress) to the API document shape. */
export function toBaseDocument(row: StoredDocumentRow, progress: StoredProgressSummary = null): BaseDocument {
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size),
    lastModified: Number(row.lastModified),
    type: normalizeDocumentType(row.type, row.name),
    scope: 'user',
    folderId: row.folderId ?? undefined,
    recentlyOpenedAt: row.recentlyOpenedAt == null ? undefined : Number(row.recentlyOpenedAt),
    contentVersion: row.id,
    ...(row.author ? { author: row.author } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(progress ? {
      readingProgress: {
        fraction: progress.progress == null ? null : Math.max(0, Math.min(1, Number(progress.progress))),
        updatedAtMs: Number(progress.updatedAt ?? 0),
      },
    } : {}),
  };
}
