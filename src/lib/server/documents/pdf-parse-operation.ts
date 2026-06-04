import { createOrReusePdfWorkerOperation } from '@/lib/server/compute/worker-op-create';
import { documentParseStateFromWorkerState } from '@/lib/server/compute/worker-parse-state';
import { documentKey } from '@/lib/server/documents/blobstore';
import { getPdfLayoutRateConfig, recordJobEvent } from '@/lib/server/rate-limit/job-rate-limiter';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import type { DocumentParseState } from '@/lib/server/documents/parse-state';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';

export async function startPdfParseOperation(input: {
  documentId: string;
  userId: string;
  namespace: string | null;
  forceToken?: string;
}): Promise<{
  workerState: WorkerOperationState<PdfLayoutJobResult>;
  parseState: DocumentParseState;
}> {
  const workerState = await createOrReusePdfWorkerOperation({
    documentId: input.documentId,
    namespace: input.namespace,
    documentObjectKey: documentKey(input.documentId, input.namespace),
    ...(input.forceToken ? { forceToken: input.forceToken } : {}),
  });
  const rateConfig = getPdfLayoutRateConfig(await getResolvedRuntimeConfig());
  await recordJobEvent(input.userId, 'pdf_layout', workerState.opId, rateConfig);
  return {
    workerState,
    parseState: documentParseStateFromWorkerState(workerState),
  };
}
