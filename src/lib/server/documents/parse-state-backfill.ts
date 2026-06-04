import { startPdfParseOperation } from '@/lib/server/documents/pdf-parse-operation';
import { enqueueParsePdfJob } from '@/lib/server/jobs/user-pdf-layout-job';
import { normalizeParseStatus, type DocumentParseState } from '@/lib/server/documents/parse-state';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';

function normalizeOpId(value: string | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

export async function backfillPendingPdfParseOperation(input: {
  documentId: string;
  userId: string;
  namespace: string | null;
  state: DocumentParseState;
}): Promise<WorkerOperationState<PdfLayoutJobResult> | null> {
  const parseStatus = normalizeParseStatus(input.state.status);
  if (parseStatus === 'ready' || parseStatus === 'failed') return null;
  if (normalizeOpId(input.state.opId)) return null;

  const startedParse = await startPdfParseOperation({
    documentId: input.documentId,
    userId: input.userId,
    namespace: input.namespace,
  });
  enqueueParsePdfJob({
    documentId: input.documentId,
    userId: input.userId,
    namespace: input.namespace,
    initialOpId: startedParse.workerState.opId,
    initialJobId: startedParse.workerState.jobId,
    initialStatus: startedParse.parseState.status === 'running' ? 'running' : 'pending',
  });
  return startedParse.workerState;
}
