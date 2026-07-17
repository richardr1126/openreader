import { z } from 'zod';
import { withTimeout } from '../infrastructure/config';
import { DOCUMENT_PREVIEW_RENDERER_VERSION, type DocumentPreviewArtifactMetadata, type DocumentPreviewJobRequest, type DocumentPreviewJobResult } from '../operations/contracts';
import { documentPreviewArtifactKey, documentPreviewMetadataArtifactKey } from '../storage/artifact-addressing';
import type { JobHandlerContext } from './context';
import { renderEpubCoverToJpeg, renderPdfFirstPageToJpeg } from './document-preview-render';

const requestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentType: z.enum(['pdf', 'epub']),
  sourceObjectKey: z.string().trim().min(1).max(2048),
  sourceLastModifiedMs: z.number().int().nonnegative(),
  previewKind: z.literal('card'),
  rendererVersion: z.string().trim().min(1).max(256).optional(),
  targetWidth: z.number().int().positive().max(2048).optional(),
}).strict();

export function createDocumentPreviewHandler(input: JobHandlerContext) {
  return async function runDocumentPreview(payload: DocumentPreviewJobRequest, queueWaitMs: number): Promise<DocumentPreviewJobResult> {
    const parsed = requestSchema.parse(payload);
    const s3FetchStartedAt = Date.now();
    const sourceBytes = Buffer.from(await withTimeout(input.storage.readObject(parsed.sourceObjectKey), Math.max(input.pdfTimeoutMs, 1_000), 'document preview source fetch'));
    const s3FetchMs = Date.now() - s3FetchStartedAt;
    const computeStartedAt = Date.now();
    const rendered = parsed.documentType === 'pdf'
      ? await renderPdfFirstPageToJpeg(sourceBytes, parsed.targetWidth ?? 400)
      : await renderEpubCoverToJpeg(sourceBytes, parsed.targetWidth ?? 400);
    const computeMs = Date.now() - computeStartedAt;
    const objectKey = documentPreviewArtifactKey({ documentId: parsed.documentId, namespace: parsed.namespace, prefix: input.s3Prefix });
    const metadataObjectKey = documentPreviewMetadataArtifactKey({ documentId: parsed.documentId, namespace: parsed.namespace, prefix: input.s3Prefix });
    await input.storage.putObject(objectKey, rendered.bytes, 'image/jpeg');
    const artifact: DocumentPreviewArtifactMetadata = {
      schemaVersion: 1,
      documentId: parsed.documentId,
      namespace: parsed.namespace,
      documentType: parsed.documentType,
      sourceObjectKey: parsed.sourceObjectKey,
      sourceLastModifiedMs: parsed.sourceLastModifiedMs,
      previewKind: parsed.previewKind,
      rendererVersion: parsed.rendererVersion?.trim() || DOCUMENT_PREVIEW_RENDERER_VERSION,
      objectKey,
      metadataObjectKey,
      contentType: 'image/jpeg',
      width: rendered.width,
      height: rendered.height,
      byteLength: rendered.bytes.byteLength,
      eTag: null,
      status: 'ready',
      createdAt: Date.now(),
    };
    await input.storage.putObject(metadataObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');
    return { artifact, timing: { queueWaitMs, s3FetchMs, computeMs } };
  };
}
