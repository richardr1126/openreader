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

const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Ids of canonical documents that have derived artifacts (layout, previews,
 * plans). The app reaps ids that have neither an owner nor a source blob, which
 * catches artifacts written after their source was already reaped.
 */
export async function listDocumentDerivedIds(input: { storage: ArtifactStorage; s3Prefix: string }): Promise<string[]> {
  const roots = [
    `${input.s3Prefix}/documents_v1/parsed_v2/`,
    `${input.s3Prefix}/document_previews_v1/ns/_default/`,
    `${input.s3Prefix}/tts_playback_plan_v1/`,
  ];
  const ids = new Set<string>();
  for (const root of roots) {
    for (const id of await input.storage.listChildPrefixes(root)) {
      if (DOCUMENT_ID_REGEX.test(id)) ids.add(id);
    }
  }
  return [...ids];
}
