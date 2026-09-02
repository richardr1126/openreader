import type { ArtifactStorage } from '../infrastructure/storage';
import {
  documentPreviewArtifactPrefix,
  parsedPdfArtifactPrefix,
  ttsPlaybackPlanArtifactPrefix,
} from './artifact-addressing';
import { deletePrefix } from './prefix-cleanup';

type DocumentArtifactCleanupInput = {
  storage: ArtifactStorage;
  s3Prefix: string;
  documentId: string;
  namespace: string | null;
};

export function clearPdfLayoutArtifacts(input: DocumentArtifactCleanupInput): Promise<number> {
  return deletePrefix(input.storage, parsedPdfArtifactPrefix({
    documentId: input.documentId,
    namespace: input.namespace,
    prefix: input.s3Prefix,
  }));
}

export function clearDocumentPreviewArtifacts(input: DocumentArtifactCleanupInput): Promise<number> {
  return deletePrefix(input.storage, documentPreviewArtifactPrefix({
    documentId: input.documentId,
    namespace: input.namespace,
    prefix: input.s3Prefix,
  }));
}

export function clearTtsPlaybackPlanArtifacts(
  input: Omit<DocumentArtifactCleanupInput, 'namespace'>,
): Promise<number> {
  return deletePrefix(input.storage, ttsPlaybackPlanArtifactPrefix({
    documentId: input.documentId,
    prefix: input.s3Prefix,
  }));
}
