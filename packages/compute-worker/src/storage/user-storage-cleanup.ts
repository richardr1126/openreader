import type { ArtifactStorage } from '../infrastructure/storage';
import { ttsPlaybackExportArtifactScopePrefix } from './artifact-addressing';
import { deletePrefix, storageUserHash } from './prefix-cleanup';

export type UserStorageCleanupResult = {
  deletedObjects: number;
  deletedDocumentArtifacts: number;
};

/** Delete only user-scoped artifacts; shared document objects remain reaper-owned. */
export async function cleanupUserStorageArtifacts(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  storageUserId: string;
  namespace: string | null;
  documentIds: string[];
}): Promise<UserStorageCleanupResult> {
  const { storage, s3Prefix, storageUserId, namespace, documentIds } = input;
  const nsSegment = namespace ? `ns/${namespace}/` : '';
  const encodedUserId = encodeURIComponent(storageUserId);
  let deletedObjects = 0;
  let deletedDocumentArtifacts = 0;

  for (const prefix of [
    `${s3Prefix}/document_uploads_temp_v1/${nsSegment}users/${encodedUserId}/`,
    `${s3Prefix}/tts_playback_segments_audio_v1/${nsSegment}users/${encodedUserId}/`,
    `${s3Prefix}/account_exports_v1/${nsSegment}users/${encodedUserId}/`,
    ttsPlaybackExportArtifactScopePrefix({ storageUserId, prefix: s3Prefix }),
    ...(namespace === null ? [`${s3Prefix}/tts_playback_segments_v1/users/${storageUserHash(storageUserId)}/`] : []),
  ]) {
    deletedObjects += await deletePrefix(storage, prefix);
  }

  if (namespace !== null) {
    for (const documentId of documentIds) {
      const deleted = await Promise.all([
        deletePrefix(storage, `${s3Prefix}/documents_v1/ns/${namespace}/${documentId}`),
        deletePrefix(storage, `${s3Prefix}/documents_v1/parsed_v2/ns/${namespace}/${documentId}/`),
        deletePrefix(storage, `${s3Prefix}/document_previews_v1/ns/${namespace}/${documentId}/`),
        // Plans are keyed by document id only; namespaced documents are
        // test-owned, so their plans go with the document artifacts.
        deletePrefix(storage, `${s3Prefix}/tts_playback_plan_v1/${documentId}/`),
      ]);
      deletedDocumentArtifacts += deleted.reduce((total, count) => total + count, 0);
    }
  }

  return { deletedObjects, deletedDocumentArtifacts };
}
