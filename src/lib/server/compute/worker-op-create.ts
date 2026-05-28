import { getWorkerClientConfigFromEnv, buildPdfOpKey } from '@/lib/server/compute/worker';
import type { PdfLayoutInput } from '@/lib/server/compute/types';
import type {
  PdfLayoutJobResult,
  WorkerOperationState,
} from '@openreader/compute-core/api-contracts';

type CreatePdfWorkerOpInput =
  Pick<PdfLayoutInput, 'documentId' | 'namespace' | 'forceToken'>
  & { documentObjectKey: string };

const CREATE_OP_TIMEOUT_MS = 10_000;

export async function createOrReusePdfWorkerOperation(
  input: CreatePdfWorkerOpInput,
): Promise<WorkerOperationState<PdfLayoutJobResult>> {
  const cfg = getWorkerClientConfigFromEnv();
  const opKey = buildPdfOpKey({
    documentId: input.documentId,
    namespace: input.namespace,
    documentObjectKey: input.documentObjectKey,
    forceToken: input.forceToken,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CREATE_OP_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/ops`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'pdf_layout',
        opKey,
        payload: {
          documentId: input.documentId,
          namespace: input.namespace,
          documentObjectKey: input.documentObjectKey,
        },
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Worker op create failed: ${res.status}${detail ? ` ${detail}` : ''}`);
    }

    const parsed = await res.json() as WorkerOperationState<PdfLayoutJobResult>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.opId !== 'string' || !parsed.opId.trim()) {
      throw new Error('Worker op create returned invalid response');
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}
