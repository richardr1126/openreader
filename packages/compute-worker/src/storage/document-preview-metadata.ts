import { createHash } from 'node:crypto';
import { DOCUMENT_PREVIEW_RENDERER_VERSION, type DocumentPreviewArtifactMetadata, type DocumentPreviewJobRequest } from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import { buildDocumentPreviewOperationKey, documentPreviewWidth } from '../operations/keys';
import { documentPreviewArtifactKey, documentPreviewMetadataArtifactKey } from './artifact-addressing';

function previewScopeHash(input: DocumentPreviewJobRequest): string {
  return createHash('sha256').update(buildDocumentPreviewOperationKey(input)).digest('hex');
}

export function documentPreviewObjectMetadata(input: DocumentPreviewJobRequest, artifact: DocumentPreviewArtifactMetadata): Record<string, string> {
  return {
    'preview-scope': previewScopeHash(input),
    'preview-width': String(artifact.width),
    'preview-height': String(artifact.height),
    'preview-created-at': String(artifact.createdAt),
  };
}

export async function readDocumentPreviewMetadata(
  storage: ArtifactStorage,
  input: DocumentPreviewJobRequest,
  prefix: string,
): Promise<DocumentPreviewArtifactMetadata | null> {
  try {
    const key = documentPreviewMetadataArtifactKey({ ...input, prefix });
    const objectKey = documentPreviewArtifactKey({ ...input, prefix });
    const head = await storage.headObject?.(objectKey);
    if (head === null) return null;
    if (head?.metadata['preview-scope'] !== undefined) {
      const width = Number(head.metadata['preview-width']);
      const height = Number(head.metadata['preview-height']);
      const createdAt = Number(head.metadata['preview-created-at']);
      if (head.metadata['preview-scope'] !== previewScopeHash(input)
        || ![width, height, createdAt, head.size].every((value) => Number.isSafeInteger(value) && Number(value) > 0)) return null;
      return {
        schemaVersion: 1,
        documentId: input.documentId,
        namespace: input.namespace,
        documentType: input.documentType,
        sourceObjectKey: input.sourceObjectKey,
        sourceLastModifiedMs: input.sourceLastModifiedMs,
        previewKind: input.previewKind,
        rendererVersion: input.rendererVersion?.trim() || DOCUMENT_PREVIEW_RENDERER_VERSION,
        objectKey, metadataObjectKey: objectKey, width, height, createdAt,
        contentType: 'image/jpeg', byteLength: head.size!, eTag: head.etag, status: 'ready',
      };
    }
    if (documentPreviewWidth(input.targetWidth) !== 400) return null;
    const parsed = JSON.parse(Buffer.from(await storage.readObject(key)).toString('utf8')) as DocumentPreviewArtifactMetadata;
    if (
      parsed.schemaVersion !== 1
      || parsed.documentId !== input.documentId
      || parsed.namespace !== input.namespace
      || parsed.documentType !== input.documentType
      || parsed.sourceObjectKey !== input.sourceObjectKey
      || parsed.sourceLastModifiedMs !== input.sourceLastModifiedMs
      || parsed.previewKind !== input.previewKind
      || parsed.rendererVersion !== (input.rendererVersion?.trim() || DOCUMENT_PREVIEW_RENDERER_VERSION)
      || parsed.objectKey !== objectKey
      || parsed.width !== 400
      || parsed.status !== 'ready'
    ) return null;
    return head || await storage.objectExists(objectKey) ? parsed : null;
  } catch {
    return null;
  }
}
