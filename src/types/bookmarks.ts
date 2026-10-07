/**
 * A bookmarked sentence, positioned exactly like reading progress: the
 * segment key is its content identity in the canonical playback plan and
 * survives re-planning; the ordinal is a hint. Both resolve through
 * `resolveReadingPositionOrdinal`.
 */
export type DocumentBookmark = {
  id: string;
  documentId: string;
  segmentKey: string;
  segmentOrdinal: number;
  /** Optional user-given name; null shows the snippet instead. */
  label: string | null;
  /** The bookmarked sentence, for list display. */
  snippet: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CreateDocumentBookmarkInput = {
  /** Optional client-generated UUID, making a retried create idempotent. */
  id?: string;
  segmentKey: string;
  segmentOrdinal: number;
  label?: string | null;
  snippet: string;
};
