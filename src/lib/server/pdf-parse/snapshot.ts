import type { PdfLayoutResult, ComputeOperation } from '@/lib/server/compute-worker/protocol';
import type { PdfParseStatus } from '@/types/parsed-pdf';
import type { PdfParseSnapshot } from '@/lib/server/pdf-parse/types';

function mapWorkerStatusToParseStatus(status: ComputeOperation['status']): PdfParseStatus {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'ready';
    case 'failed':
      return 'failed';
  }

  const exhaustive: never = status;
  return exhaustive;
}

export function parsedObjectKeyFromWorkerState(
  state: ComputeOperation<PdfLayoutResult>,
): string | null {
  const result = state.result;
  if (!result || typeof result !== 'object' || !('parsedObjectKey' in result)) return null;
  const value = result.parsedObjectKey;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function pdfParseSnapshotFromWorkerState(
  state: ComputeOperation<PdfLayoutResult>,
): PdfParseSnapshot {
  const parseStatus = mapWorkerStatusToParseStatus(state.status);
  return {
    parseStatus,
    parseProgress: parseStatus === 'running' ? (state.progress ?? null) : null,
    opId: state.opId?.trim() || null,
    ...(parseStatus === 'failed' && state.error?.message ? { error: state.error.message } : {}),
  };
}
