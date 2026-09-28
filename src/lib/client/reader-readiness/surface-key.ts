import type { ReaderPayload } from '@/types/reader-bootstrap';

/**
 * Immutable identity for one server-authoritative reader surface: the rendered
 * document content. A re-plan (voice, speed, language, segmentation) keeps the
 * surface mounted and swaps its playback plan in place.
 */
export function readerSurfaceKey(payload: ReaderPayload): string {
  return [
    payload.readerType,
    payload.documentId,
    payload.document.contentVersion ?? payload.document.id,
  ].join(':');
}
