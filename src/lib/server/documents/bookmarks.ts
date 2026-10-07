import { userDocumentBookmarks } from '@openreader/database/schema';
import type { DocumentBookmark } from '@/types/bookmarks';
import type { DocumentProgressRecord } from '@/types/user-state';
import {
  normalizeEpubProgressLocator,
  parseEpubProgressLocator,
  serializeEpubProgressLocator,
} from '@/lib/shared/epub-progress';
import { parseReaderInitialPosition } from '@/lib/shared/reader-position';

export const BOOKMARK_LABEL_MAX_LENGTH = 200;
export const BOOKMARK_SNIPPET_MAX_LENGTH = 500;
export const BOOKMARK_SEGMENT_KEY_MAX_LENGTH = 512;
export const MAX_BOOKMARKS_PER_DOCUMENT = 1000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BookmarkRow = {
  id: string;
  documentId: string;
  readerType: string;
  location: string;
  segmentKey: string | null;
  segmentOrdinal: number | null;
  label: string | null;
  snippet: string;
  createdAt: number | null;
  updatedAt: number | null;
};

/** Column selection matching {@link BookmarkRow}, for selects and `returning`. */
export const bookmarkSelection = {
  id: userDocumentBookmarks.id,
  documentId: userDocumentBookmarks.documentId,
  readerType: userDocumentBookmarks.readerType,
  location: userDocumentBookmarks.location,
  segmentKey: userDocumentBookmarks.segmentKey,
  segmentOrdinal: userDocumentBookmarks.segmentOrdinal,
  label: userDocumentBookmarks.label,
  snippet: userDocumentBookmarks.snippet,
  createdAt: userDocumentBookmarks.createdAt,
  updatedAt: userDocumentBookmarks.updatedAt,
};

export type ParsedBookmarkCreate = {
  id: string | null;
  readerType: 'pdf' | 'epub' | 'html';
  location: string;
  segmentKey: string | null;
  segmentOrdinal: number | null;
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

/** Same location grammar the progress route stores, validated by the reader parser. */
function normalizeLocation(readerType: 'pdf' | 'html', value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const location = value.trim();
  if (!location) return null;
  const probe: DocumentProgressRecord = {
    documentId: '',
    readerType,
    location,
    progress: null,
    clientUpdatedAtMs: 0,
    updatedAtMs: 0,
  };
  return parseReaderInitialPosition(readerType, probe) ? location : null;
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

  const readerType = record.readerType;
  if (readerType !== 'pdf' && readerType !== 'epub' && readerType !== 'html') {
    return { ok: false, error: "Invalid readerType. Expected 'pdf', 'epub', or 'html'." };
  }

  let location: string | null;
  if (readerType === 'epub') {
    const locator = normalizeEpubProgressLocator(record.locator);
    location = locator ? serializeEpubProgressLocator(locator) : null;
    if (!location) return { ok: false, error: 'Invalid EPUB bookmark locator' };
  } else {
    location = normalizeLocation(readerType, record.location);
    if (!location) return { ok: false, error: 'Invalid location' };
  }

  const label = normalizeBookmarkLabel(record.label);
  if (label === false) return { ok: false, error: 'Invalid label' };

  if (typeof record.snippet !== 'string') return { ok: false, error: 'Invalid snippet' };
  const snippet = collapseWhitespace(record.snippet).slice(0, BOOKMARK_SNIPPET_MAX_LENGTH);

  let segmentKey: string | null = null;
  if (record.segmentKey !== undefined && record.segmentKey !== null) {
    if (typeof record.segmentKey !== 'string') return { ok: false, error: 'Invalid segmentKey' };
    const key = record.segmentKey.trim();
    if (!key || key.length > BOOKMARK_SEGMENT_KEY_MAX_LENGTH) return { ok: false, error: 'Invalid segmentKey' };
    segmentKey = key;
  }

  let segmentOrdinal: number | null = null;
  if (record.segmentOrdinal !== undefined && record.segmentOrdinal !== null) {
    const ordinal = record.segmentOrdinal;
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) {
      return { ok: false, error: 'Invalid segmentOrdinal' };
    }
    segmentOrdinal = ordinal;
  }

  return {
    ok: true,
    value: { id, readerType, location, segmentKey, segmentOrdinal, label: label ?? null, snippet },
  };
}

/** Maps a stored row to the API shape; null for a row whose position no longer parses. */
export function toDocumentBookmark(row: BookmarkRow): DocumentBookmark | null {
  const base = {
    id: row.id,
    documentId: row.documentId,
    label: row.label ?? null,
    snippet: row.snippet ?? '',
    segmentKey: row.segmentKey ?? null,
    segmentOrdinal: row.segmentOrdinal == null ? null : Number(row.segmentOrdinal),
    createdAtMs: Number(row.createdAt ?? 0),
    updatedAtMs: Number(row.updatedAt ?? 0),
  };
  if (row.readerType === 'epub') {
    const locator = parseEpubProgressLocator(row.location);
    return locator ? { ...base, readerType: 'epub', locator } : null;
  }
  if (row.readerType === 'pdf' || row.readerType === 'html') {
    return { ...base, readerType: row.readerType, location: row.location };
  }
  return null;
}
