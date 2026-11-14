import { DOCUMENT_PREVIEW_RENDERER_VERSION, type DocumentPreviewArtifactMetadata, type DocumentPreviewJobRequest } from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import { documentPreviewMetadataArtifactKey } from './artifact-addressing';

export async function readDocumentPreviewMetadata(
  storage: ArtifactStorage,
  input: Omit<DocumentPreviewJobRequest, 'targetWidth'>,
  prefix: string,
): Promise<DocumentPreviewArtifactMetadata | null> {
  try {
    const key = documentPreviewMetadataArtifactKey({ ...input, prefix });
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
      || parsed.status !== 'ready'
    ) return null;
    return await storage.objectExists(parsed.objectKey) ? parsed : null;
  } catch {
    return null;
  }
}
