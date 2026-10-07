import type { EpubProgressLocator } from '@/types/user-state';

/**
 * Where a bookmark points, in the same per-reader encoding as reading
 * progress: PDF and HTML store the serialized reader position
 * (`serializeReaderPosition`), EPUB stores the structured progress locator.
 */
export type DocumentBookmarkPosition =
  | { readerType: 'pdf' | 'html'; location: string }
  | { readerType: 'epub'; locator: EpubProgressLocator };

type DocumentBookmarkBase = {
  id: string;
  documentId: string;
  /** Optional user-given name; null shows the snippet instead. */
  label: string | null;
  /** The bookmarked sentence (or the visible text near it), for list display. */
  snippet: string;
  /**
   * Content identity of the bookmarked sentence in the canonical playback
   * plan, when one was known. Survives re-planning; prefer it over
   * `segmentOrdinal`, which is only a hint.
   */
  segmentKey: string | null;
  segmentOrdinal: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DocumentBookmark = DocumentBookmarkBase & DocumentBookmarkPosition;

export type CreateDocumentBookmarkInput = DocumentBookmarkPosition & {
  /** Optional client-generated UUID, making a retried create idempotent. */
  id?: string;
  label?: string | null;
  snippet: string;
  segmentKey?: string | null;
  segmentOrdinal?: number | null;
};
