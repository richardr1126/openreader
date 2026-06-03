import { createOrReusePdfWorkerOperation } from '@/lib/server/compute/worker-op-create';
import { documentKey } from '@/lib/server/documents/blobstore';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getPdfLayoutRateConfig, recordJobEvent } from '@/lib/server/rate-limit/job-rate-limiter';
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

  const created = await createOrReusePdfWorkerOperation({
    documentId: input.documentId,
    namespace: input.namespace,
    documentObjectKey: documentKey(input.documentId, input.namespace),
  });

  const rateConfig = getPdfLayoutRateConfig(await getResolvedRuntimeConfig());
  await recordJobEvent(input.userId, 'pdf_layout', created.opId, rateConfig);
  return created;
}
