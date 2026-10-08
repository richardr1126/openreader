import { userDocumentBookmarks } from '@openreader/database/schema';
import type { DocumentBookmark } from '@/types/bookmarks';
import { parseReadingPositionInput } from '@/lib/shared/reading-position';

export const BOOKMARK_LABEL_MAX_LENGTH = 200;
export const BOOKMARK_SNIPPET_MAX_LENGTH = 500;
export const MAX_BOOKMARKS_PER_DOCUMENT = 1000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BookmarkRow = {
  id: string;
  documentId: string;
  segmentKey: string;
  segmentOrdinal: number;
  label: string | null;
  snippet: string;
  createdAt: number | null;
  updatedAt: number | null;
};

/** Column selection matching {@link BookmarkRow}, for selects and `returning`. */
export const bookmarkSelection = {
  id: userDocumentBookmarks.id,
  documentId: userDocumentBookmarks.documentId,
  segmentKey: userDocumentBookmarks.segmentKey,
  segmentOrdinal: userDocumentBookmarks.segmentOrdinal,
  label: userDocumentBookmarks.label,
  snippet: userDocumentBookmarks.snippet,
  createdAt: userDocumentBookmarks.createdAt,
  updatedAt: userDocumentBookmarks.updatedAt,
};

export type ParsedBookmarkCreate = {
  id: string | null;
  segmentKey: string;
  segmentOrdinal: number;
  label: string | null;
  snippet: string;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function isValidBookmarkId(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * `undefined` means "not provided"; null or a blank string clears the label.
 * Returns `false` for a value that is not a label at all.
 */
export function normalizeBookmarkLabel(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return false;
  const label = collapseWhitespace(value).slice(0, BOOKMARK_LABEL_MAX_LENGTH);
  return label || null;
}

export function parseBookmarkCreateBody(body: unknown): ParseResult<ParsedBookmarkCreate> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request body' };
  const record = body as Record<string, unknown>;

  let id: string | null = null;
  if (record.id !== undefined && record.id !== null) {
    const candidate = typeof record.id === 'string' ? record.id.trim().toLowerCase() : '';
    if (!isValidBookmarkId(candidate)) return { ok: false, error: 'Invalid bookmark id' };
    id = candidate;
  }

  const position = parseReadingPositionInput(record);
  if (!position) return { ok: false, error: 'Invalid segment position' };

  const label = normalizeBookmarkLabel(record.label);
  if (label === false) return { ok: false, error: 'Invalid label' };

  if (typeof record.snippet !== 'string') return { ok: false, error: 'Invalid snippet' };
  const snippet = collapseWhitespace(record.snippet).slice(0, BOOKMARK_SNIPPET_MAX_LENGTH);

  return {
    ok: true,
    value: { id, ...position, label: label ?? null, snippet },
  };
}

/** Maps a stored row to the API shape. */
export function toDocumentBookmark(row: BookmarkRow): DocumentBookmark {
  return {
    id: row.id,
    documentId: row.documentId,
    segmentKey: row.segmentKey,
    segmentOrdinal: Number(row.segmentOrdinal),
    label: row.label ?? null,
    snippet: row.snippet ?? '',
    createdAtMs: Number(row.createdAt ?? 0),
    updatedAtMs: Number(row.updatedAt ?? 0),
  };
}
