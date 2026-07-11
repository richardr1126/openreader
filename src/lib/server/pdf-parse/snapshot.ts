import type { PdfLayoutResult, ComputeOperation } from '@/lib/server/compute-worker/protocol';
import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
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

function isPdfParseProgress(value: unknown): value is PdfParseProgress {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return Number.isFinite(Number(rec.totalPages))
    && Number.isFinite(Number(rec.pagesParsed))
    && (rec.phase === 'infer' || rec.phase === 'merge');
}

export function pdfParseSnapshotFromWorkerState(
  state: ComputeOperation<PdfLayoutResult>,
): PdfParseSnapshot {
  const parseStatus = mapWorkerStatusToParseStatus(state.status);
  const progress = isPdfParseProgress(state.progress) ? state.progress : null;
  return {
    parseStatus,
    parseProgress: parseStatus === 'running' ? progress : null,
    opId: state.opId?.trim() || null,
    ...(parseStatus === 'failed' && state.error?.message ? { error: state.error.message } : {}),
  };
}
