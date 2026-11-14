import { z } from 'zod';
import { withTimeout } from '../infrastructure/config';
import { DOCUMENT_PREVIEW_RENDERER_VERSION, type DocumentPreviewArtifactMetadata, type DocumentPreviewJobRequest, type DocumentPreviewJobResult } from '../operations/contracts';
import { documentPreviewArtifactKey } from '../storage/artifact-addressing';
import type { JobHandlerContext } from './context';
import type { JobAttempt } from '../operations/types';
import { prepareArtifactWrite, publishOrAdoptArtifact } from '../storage/artifact-write';
import { documentPreviewObjectMetadata, readDocumentPreviewMetadata } from '../storage/document-preview-metadata';
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
  return async function runDocumentPreview(payload: DocumentPreviewJobRequest, queueWaitMs: number, attempt?: JobAttempt): Promise<DocumentPreviewJobResult> {
    const parsed = requestSchema.parse(payload);
    const scope = { ...parsed, prefix: input.s3Prefix };
    const objectKey = documentPreviewArtifactKey(scope);
    const writePreview = await prepareArtifactWrite(input.storage, objectKey, attempt);
    if (attempt && attempt.attempt > 1) {
      const existing = await readDocumentPreviewMetadata(input.storage, parsed, input.s3Prefix);
      if (existing) return { artifact: existing, timing: { queueWaitMs, computeMs: 0 } };
    }
    const s3FetchStartedAt = Date.now();
    const sourceBytes = Buffer.from(await withTimeout(input.storage.readObject(parsed.sourceObjectKey), Math.max(input.pdfTimeoutMs, 1_000), 'document preview source fetch'));
    const s3FetchMs = Date.now() - s3FetchStartedAt;
    const computeStartedAt = Date.now();
    const rendered = parsed.documentType === 'pdf'
      ? await renderPdfFirstPageToJpeg(sourceBytes, parsed.targetWidth ?? 400)
      : await renderEpubCoverToJpeg(sourceBytes, parsed.targetWidth ?? 400);
    const computeMs = Date.now() - computeStartedAt;
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
      metadataObjectKey: objectKey,
      contentType: 'image/jpeg',
      width: rendered.width,
      height: rendered.height,
      byteLength: rendered.bytes.byteLength,
      eTag: null,
      status: 'ready',
      createdAt: Date.now(),
    };
    const winner = await publishOrAdoptArtifact(
      () => writePreview(rendered.bytes, 'image/jpeg', documentPreviewObjectMetadata(parsed, artifact)),
      () => readDocumentPreviewMetadata(input.storage, parsed, input.s3Prefix),
      attempt,
    );
    return { artifact: winner ?? artifact, timing: { queueWaitMs, s3FetchMs, computeMs } };
  };
}
