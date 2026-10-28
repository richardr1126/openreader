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
 *
 * Two listing passes keep memory to one timestamp per folder: the first finds
 * each folder's newest object, the second deletes the objects of expired
 * folders page by page. An object written between the passes is kept.
 */
export async function expireArtifactFoldersUnderRoot(input: {
  storage: ArtifactStorage;
  root: string;
  maxAgeMs: number;
  now?: number;
}): Promise<ArtifactRetentionResult> {
  const cutoff = (input.now ?? Date.now()) - input.maxAgeMs;
  const folderOf = (key: string) => key.slice(0, key.lastIndexOf('/') + 1);
  const newestByFolder = new Map<string, number>();
  for await (const page of input.storage.listPrefixPages(input.root)) {
    for (const object of page) {
      const folder = folderOf(object.key);
      newestByFolder.set(folder, Math.max(newestByFolder.get(folder) ?? 0, object.lastModifiedMs));
    }
  }

  const expiredFolders = new Set<string>();
  let deletedObjects = 0;
  for await (const page of input.storage.listPrefixPages(input.root)) {
    const keys = page.flatMap((object) => {
      const folder = folderOf(object.key);
      const newestMs = newestByFolder.get(folder);
      if (newestMs === undefined || newestMs >= cutoff || object.lastModifiedMs >= cutoff) return [];
      expiredFolders.add(folder);
      return [object.key];
    });
    for (let index = 0; index < keys.length; index += DELETE_BATCH) {
      await Promise.all(keys.slice(index, index + DELETE_BATCH).map((key) => input.storage.deleteObject(key)));
    }
    deletedObjects += keys.length;
  }
  return { expiredArtifacts: expiredFolders.size, deletedObjects };
}
