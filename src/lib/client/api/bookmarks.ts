import type { CreateDocumentBookmarkInput, DocumentBookmark } from '@/types/bookmarks';
import { requestJson } from '@/lib/client/api/http';

function bookmarksUrl(documentId: string, bookmarkId?: string): string {
  const base = `/api/documents/${encodeURIComponent(documentId)}/bookmarks`;
  return bookmarkId ? `${base}/${encodeURIComponent(bookmarkId)}` : base;
}

/** Newest first. */
export async function listDocumentBookmarks(
  documentId: string,
  options?: { signal?: AbortSignal },
): Promise<DocumentBookmark[]> {
  const data = await requestJson<{ bookmarks: DocumentBookmark[] }>(
    bookmarksUrl(documentId),
    { signal: options?.signal, cache: 'no-store' },
    'Failed to load bookmarks',
  );
  return data.bookmarks ?? [];
}

/** Creating with a client-supplied `id` is idempotent, so a retry returns the stored bookmark. */
export async function createDocumentBookmark(
  documentId: string,
  input: CreateDocumentBookmarkInput,
  options?: { signal?: AbortSignal },
): Promise<DocumentBookmark> {
  const data = await requestJson<{ bookmark: DocumentBookmark }>(
    bookmarksUrl(documentId),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: options?.signal,
    },
    'Failed to create bookmark',
  );
  return data.bookmark;
}

/** A null or blank label clears it. */
export async function renameDocumentBookmark(
  documentId: string,
  bookmarkId: string,
  label: string | null,
  options?: { signal?: AbortSignal },
): Promise<DocumentBookmark> {
  const data = await requestJson<{ bookmark: DocumentBookmark }>(
    bookmarksUrl(documentId, bookmarkId),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
      signal: options?.signal,
    },
    'Failed to rename bookmark',
  );
  return data.bookmark;
}

/** Resolves `false` when the bookmark was already gone. */
export async function deleteDocumentBookmark(
  documentId: string,
  bookmarkId: string,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  const data = await requestJson<{ deleted: boolean }>(
    bookmarksUrl(documentId, bookmarkId),
    { method: 'DELETE', signal: options?.signal },
    'Failed to delete bookmark',
  );
  return data.deleted;
}
