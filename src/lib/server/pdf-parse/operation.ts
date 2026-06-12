import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { documentKey } from '@/lib/server/documents/blobstore';
import type {
  PdfLayoutResolution,
  PdfLayoutResult,
  WorkerOperation,
} from '@/lib/server/compute-worker/protocol';

function currentPdfOperationInput(documentId: string, namespace: string | null, forceToken?: string): {
  documentId: string;
  namespace: string | null;
  documentObjectKey: string;
  replaceToken?: string;
} {
  return {
    documentId,
    namespace,
    documentObjectKey: documentKey(documentId, namespace),
    ...(forceToken ? { replaceToken: forceToken } : {}),
  };
}

export async function resolveCurrentPdfParse(input: {
  documentId: string;
  namespace: string | null;
}): Promise<PdfLayoutResolution> {
  return getComputeWorkerClient().resolvePdfLayout(currentPdfOperationInput(
    input.documentId,
    input.namespace,
  ));
}

export async function lookupCurrentPdfParseOperation(input: {
  documentId: string;
  namespace: string | null;
}): Promise<WorkerOperation<PdfLayoutResult> | null> {
  return (await resolveCurrentPdfParse(input)).operation;
}

export async function createOrReuseCurrentPdfParseOperation(input: {
  documentId: string;
  namespace: string | null;
  forceToken?: string;
}): Promise<WorkerOperation<PdfLayoutResult>> {
  return getComputeWorkerClient().createPdfLayoutOperation(currentPdfOperationInput(
    input.documentId,
    input.namespace,
    input.forceToken,
  ));
}

export async function fetchPdfParseOperation(opId: string): Promise<WorkerOperation<PdfLayoutResult> | null> {
  return getComputeWorkerClient().getOperation<PdfLayoutResult>(opId);
}

export function isPdfParseOperationForDocument(
  state: WorkerOperation<PdfLayoutResult>,
  input: {
    documentId: string;
    namespace: string | null;
  },
): boolean {
  return state.subject.kind === 'pdf_layout'
    && state.subject.documentId === input.documentId
    && state.subject.namespace === input.namespace;
}
