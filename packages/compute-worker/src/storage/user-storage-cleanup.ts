import { createHash } from 'node:crypto';
import type { ArtifactStorage } from '../infrastructure/storage';

export type UserStorageCleanupResult = {
  deletedObjects: number;
  deletedDocumentArtifacts: number;
};

function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

async function deletePrefix(storage: ArtifactStorage, prefix: string): Promise<number> {
  const keys = await storage.listPrefix(prefix);
  for (let index = 0; index < keys.length; index += 32) {
    await Promise.all(keys.slice(index, index + 32).map((key) => storage.deleteObject(key)));
  }
  return keys.length;
}

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
      ]);
      deletedDocumentArtifacts += deleted.reduce((total, count) => total + count, 0);
    }
  }

  // Audiobook exports predate scoped object paths. Their metadata is the
  // durable ownership index, so this worker-only scan is the safe cleanup path.
  const exportRoot = `${s3Prefix}/tts_playback_exports_v1/`;
  const metadataKeys = (await storage.listPrefix(exportRoot)).filter((key) => key.endsWith('/metadata.json'));
  const exportPrefixes = new Set<string>();
  for (const key of metadataKeys) {
    const metadata = await storage.readObject(key)
      .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as { storageUserId?: unknown })
      .catch(() => null);
    if (metadata?.storageUserId === storageUserId) {
      exportPrefixes.add(key.slice(0, -'metadata.json'.length));
    }
  }
  for (const prefix of exportPrefixes) {
    deletedObjects += await deletePrefix(storage, prefix);
  }

  return { deletedObjects, deletedDocumentArtifacts };
}
