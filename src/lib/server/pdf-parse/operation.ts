import { buildPdfOpKey } from '@/lib/server/compute/worker';
import { createOrReusePdfWorkerOperation } from '@/lib/server/compute/worker-op-create';
import {
  fetchWorkerOperationState,
  fetchWorkerOperationStateByKey,
} from '@/lib/server/compute/worker-op-state';
import { documentKey } from '@/lib/server/documents/blobstore';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';

function currentPdfOperationInput(documentId: string, namespace: string | null, forceToken?: string): {
  documentId: string;
  namespace: string | null;
  documentObjectKey: string;
  forceToken?: string;
} {
  return {
    documentId,
    namespace,
    documentObjectKey: documentKey(documentId, namespace),
    ...(forceToken ? { forceToken } : {}),
  };
}

export function buildCurrentPdfParseOpKeyPrefix(input: {
  documentId: string;
  namespace: string | null;
}): string {
  return buildPdfOpKey(currentPdfOperationInput(input.documentId, input.namespace));
}

export async function lookupCurrentPdfParseOperation(input: {
  documentId: string;
  namespace: string | null;
}): Promise<WorkerOperationState<PdfLayoutJobResult> | null> {
  return fetchWorkerOperationStateByKey<PdfLayoutJobResult>(
    buildCurrentPdfParseOpKeyPrefix(input),
  );
}

export async function createOrReuseCurrentPdfParseOperation(input: {
  documentId: string;
  namespace: string | null;
  forceToken?: string;
}): Promise<WorkerOperationState<PdfLayoutJobResult>> {
  return createOrReusePdfWorkerOperation(currentPdfOperationInput(
    input.documentId,
    input.namespace,
    input.forceToken,
  ));
}

export async function fetchPdfParseOperation(opId: string): Promise<WorkerOperationState<PdfLayoutJobResult> | null> {
  return fetchWorkerOperationState<PdfLayoutJobResult>(opId);
}

export function isPdfParseOperationForDocument(
  state: WorkerOperationState<PdfLayoutJobResult>,
  input: {
    documentId: string;
    namespace: string | null;
  },
): boolean {
  if (state.kind !== 'pdf_layout') return false;
  return state.opKey.startsWith(buildCurrentPdfParseOpKeyPrefix(input));
}
