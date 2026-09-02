import { createHash } from 'node:crypto';
import type { ArtifactStorage } from '../infrastructure/storage';

const DELETE_BATCH = 32;
const METADATA_READ_BATCH = 32;

/** Hash used for user-scoped playback sidecar object paths (see artifact-addressing). */
export function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

export async function deletePrefix(storage: ArtifactStorage, prefix: string): Promise<number> {
  const keys = await storage.listPrefix(prefix);
  for (let index = 0; index < keys.length; index += DELETE_BATCH) {
    await Promise.all(keys.slice(index, index + DELETE_BATCH).map((key) => storage.deleteObject(key)));
  }
  return keys.length;
}

/**
 * List export artifact directory prefixes under `exportRoot` whose metadata
 * sidecar matches `ownsMetadata`. Metadata reads are batched; unreadable
 * metadata is skipped rather than failing the cleanup.
 */
export async function findExportArtifactPrefixesByMetadata(input: {
  storage: ArtifactStorage;
  exportRoot: string;
  ownsMetadata: (metadata: Record<string, unknown>) => boolean;
}): Promise<string[]> {
  const metadataKeys = (await input.storage.listPrefix(input.exportRoot))
    .filter((key) => key.endsWith('/metadata.json'));
  const owned: string[] = [];
  for (let index = 0; index < metadataKeys.length; index += METADATA_READ_BATCH) {
    await Promise.all(metadataKeys.slice(index, index + METADATA_READ_BATCH).map(async (key) => {
      const metadata = await input.storage.readObject(key)
        .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>)
        .catch(() => null);
      if (metadata && input.ownsMetadata(metadata)) owned.push(key.slice(0, -'metadata.json'.length));
    }));
  }
  return owned;
}
