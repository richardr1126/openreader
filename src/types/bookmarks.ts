/**
 * A bookmarked sentence, or a highlight over a run of sentences, positioned
 * exactly like reading progress: the segment key is its content identity in
 * the canonical playback plan and survives re-planning; the ordinal is a hint.
 * Both ends resolve through `resolveReadingPositionOrdinal`. A highlight is a
 * row with an end; a bookmark has none.
 */
export type DocumentBookmark = {
  id: string;
  documentId: string;
  segmentKey: string;
  segmentOrdinal: number;
  /** The last sentence a highlight covers; both null on a bookmark. */
  endSegmentKey: string | null;
  endSegmentOrdinal: number | null;
  /** Optional user-given name; null shows the snippet instead. */
  label: string | null;
  /** The bookmarked sentence or the start of the highlight, for list display. */
  snippet: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CreateDocumentBookmarkInput = {
  /** Optional client-generated UUID, making a retried create idempotent. */
  id?: string;
  segmentKey: string;
  segmentOrdinal: number;
  /** Given together, and only for a highlight. */
  endSegmentKey?: string;
  endSegmentOrdinal?: number;
  label?: string | null;
  snippet: string;
};

export function isHighlight(bookmark: Pick<DocumentBookmark, 'endSegmentOrdinal'>): boolean {
  return bookmark.endSegmentOrdinal !== null;
}
