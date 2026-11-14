import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { documentKey } from '@/lib/server/documents/blobstore';
import type {
  PdfLayoutResolution,
  PdfLayoutResult,
  ComputeOperation,
} from '@/lib/server/compute-worker/protocol';

function currentPdfOperationInput(input: {
  documentId: string;
  namespace: string | null;
  forceToken?: string;
  supersedeOpId?: string;
}): {
  documentId: string;
  namespace: string | null;
  documentObjectKey: string;
  replaceToken?: string;
  supersedeOpId?: string;
} {
  return {
    documentId: input.documentId,
    namespace: input.namespace,
    documentObjectKey: documentKey(input.documentId, input.namespace),
    ...(input.forceToken ? { replaceToken: input.forceToken } : {}),
    ...(input.supersedeOpId ? { supersedeOpId: input.supersedeOpId } : {}),
  };
}

export async function resolveCurrentPdfParse(input: {
  documentId: string;
  namespace: string | null;
}): Promise<PdfLayoutResolution> {
  return getComputeWorkerClient().resolvePdfLayout(currentPdfOperationInput(input));
}

export async function createOrReuseCurrentPdfParseOperation(input: {
  documentId: string;
  namespace: string | null;
  forceToken?: string;
  /** Replace this operation instead of reusing it, keeping the same operation key. */
  supersedeOpId?: string;
}): Promise<ComputeOperation<PdfLayoutResult>> {
  return getComputeWorkerClient().createPdfLayoutOperation(currentPdfOperationInput(input));
}

export async function fetchPdfParseOperation(opId: string): Promise<ComputeOperation<PdfLayoutResult> | null> {
  return getComputeWorkerClient().getOperation<PdfLayoutResult>(opId);
}

export function isPdfParseOperationForDocument(
  state: ComputeOperation<PdfLayoutResult>,
  input: {
    documentId: string;
    namespace: string | null;
  },
): boolean {
  return state.subject.kind === 'pdf_layout'
    && state.subject.documentId === input.documentId
    && state.subject.namespace === input.namespace;
}
