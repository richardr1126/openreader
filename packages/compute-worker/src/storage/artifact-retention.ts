import type { ArtifactStorage } from '../infrastructure/storage';

const DELETE_BATCH = 32;

export type ArtifactRetentionResult = {
  expiredArtifacts: number;
  deletedObjects: number;
};

/**
 * Delete artifact folders under `root` (the objects sharing one parent key)
 * whose newest object is older than the retention window.
 *
 * Age comes from object timestamps rather than a metadata sidecar, so a folder
 * left behind by a crash before its metadata was written still expires, while
 * a folder that is still being written has a fresh object and is kept.
 */
export async function expireArtifactFoldersUnderRoot(input: {
  storage: ArtifactStorage;
  root: string;
  maxAgeMs: number;
  now?: number;
}): Promise<ArtifactRetentionResult> {
  const cutoff = (input.now ?? Date.now()) - input.maxAgeMs;
  const folders = new Map<string, { newestMs: number; keys: string[] }>();
  for await (const page of input.storage.listPrefixPages(input.root)) {
    for (const object of page) {
      const folder = object.key.slice(0, object.key.lastIndexOf('/') + 1);
      const entry = folders.get(folder) ?? { newestMs: 0, keys: [] };
      entry.newestMs = Math.max(entry.newestMs, object.lastModifiedMs);
      entry.keys.push(object.key);
      folders.set(folder, entry);
    }
  }

  let expiredArtifacts = 0;
  let deletedObjects = 0;
  for (const { newestMs, keys } of folders.values()) {
    if (newestMs >= cutoff) continue;
    for (let index = 0; index < keys.length; index += DELETE_BATCH) {
      await Promise.all(keys.slice(index, index + DELETE_BATCH).map((key) => input.storage.deleteObject(key)));
    }
    expiredArtifacts += 1;
    deletedObjects += keys.length;
  }
  return { expiredArtifacts, deletedObjects };
}
