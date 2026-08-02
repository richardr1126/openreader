import type { PdfLayoutResolution } from '@/lib/server/compute-worker/protocol';

/**
 * A current queued, running, or failed parse operation is newer than any
 * artifact that was already present when the operation began. This is most
 * visible during force reparse: the old artifact remains readable until the
 * replacement atomically overwrites it, but it must not make the reader look
 * ready while replacement work is still authoritative.
 */
export function shouldPreferCurrentPdfParseOperation(
  resolution: PdfLayoutResolution,
): boolean {
  return Boolean(
    resolution.operation
    && resolution.operation.status !== 'succeeded',
  );
}
