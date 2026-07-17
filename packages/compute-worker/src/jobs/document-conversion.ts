import { createHash } from 'node:crypto';
import { z } from 'zod';
import { convertDocxBufferToPdfBuffer } from '../inference/docx/convert';
import { withTimeout } from '../infrastructure/config';
import { DOCX_CONVERTER_VERSION, type DocumentConversionArtifactMetadata, type DocumentConversionJobRequest, type DocumentConversionJobResult, type DocumentConversionProgress } from '../operations/contracts';
import { documentConversionArtifactKey, documentConversionMetadataArtifactKey } from '../storage/artifact-addressing';
import type { JobHandlerContext } from './context';

const requestSchema = z.object({
  conversionId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  namespace: z.string().trim().min(1).max(128).nullable(),
  sourceObjectKey: z.string().trim().min(1).max(2048),
  sourceLastModifiedMs: z.number().int().nonnegative(),
  sourceContentType: z.string().trim().min(1).max(256),
  sourceEtag: z.string().trim().min(1).max(256).nullable().optional(),
  converterVersion: z.string().trim().min(1).max(256).optional(),
}).strict();

export function createDocumentConversionHandler(input: JobHandlerContext) {
  return async function runDocumentConversion(
    payload: DocumentConversionJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: DocumentConversionProgress) => Promise<void> },
  ): Promise<DocumentConversionJobResult> {
    const parsed = requestSchema.parse(payload);
    const metadataObjectKey = documentConversionMetadataArtifactKey({ conversionId: parsed.conversionId, namespace: parsed.namespace, prefix: input.s3Prefix });
    const existingMetadata = await input.storage.readObject(metadataObjectKey)
      .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as DocumentConversionArtifactMetadata)
      .catch(() => null);
    if (
      existingMetadata?.schemaVersion === 1
      && existingMetadata.status === 'ready'
      && existingMetadata.sourceObjectKey === parsed.sourceObjectKey
      && existingMetadata.sourceLastModifiedMs === parsed.sourceLastModifiedMs
      && existingMetadata.sourceContentType === parsed.sourceContentType
      && existingMetadata.sourceEtag === (parsed.sourceEtag ?? null)
      && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)
    ) {
      return { artifact: existingMetadata, timing: { queueWaitMs, computeMs: 0 } };
    }
    await hooks?.onProgress?.({ phase: 'fetching' });
    const s3FetchStartedAt = Date.now();
    const sourceBytes = Buffer.from(await withTimeout(input.storage.readObject(parsed.sourceObjectKey), Math.max(input.pdfTimeoutMs, 1_000), 'docx conversion source fetch'));
    const s3FetchMs = Date.now() - s3FetchStartedAt;
    await hooks?.onProgress?.({ phase: 'converting' });
    const computeStartedAt = Date.now();
    const pdfBytes = await convertDocxBufferToPdfBuffer(sourceBytes);
    const computeMs = Date.now() - computeStartedAt;
    await hooks?.onProgress?.({ phase: 'uploading' });
    const objectKey = documentConversionArtifactKey({ conversionId: parsed.conversionId, namespace: parsed.namespace, prefix: input.s3Prefix });
    const documentId = createHash('sha256').update(pdfBytes).digest('hex');
    await input.storage.putObject(objectKey, pdfBytes, 'application/pdf');
    const artifact: DocumentConversionArtifactMetadata = {
      schemaVersion: 1,
      conversionId: parsed.conversionId,
      namespace: parsed.namespace,
      sourceObjectKey: parsed.sourceObjectKey,
      sourceLastModifiedMs: parsed.sourceLastModifiedMs,
      sourceContentType: parsed.sourceContentType,
      sourceEtag: parsed.sourceEtag ?? null,
      converterVersion: parsed.converterVersion?.trim() || DOCX_CONVERTER_VERSION,
      objectKey,
      metadataObjectKey,
      contentType: 'application/pdf',
      byteLength: pdfBytes.byteLength,
      documentId,
      status: 'ready',
      createdAt: Date.now(),
    };
    await input.storage.putObject(metadataObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');
    return { artifact, timing: { queueWaitMs, s3FetchMs, computeMs } };
  };
}
