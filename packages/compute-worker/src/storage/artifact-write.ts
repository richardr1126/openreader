import type { JobAttempt } from '../operations/types';
import type { ArtifactStorage } from '../infrastructure/storage';

/** Capture the object revision before compute and check ownership before the write. */
export async function prepareArtifactWrite(storage: ArtifactStorage, key: string, attempt?: JobAttempt) {
  const signal = attempt?.signal;
  const etag = attempt ? await storage.getObjectEtag?.(key, signal) : undefined;
  return async (body: Buffer | Uint8Array, contentType: string): Promise<void> => {
    await attempt?.assertActive();
    signal?.throwIfAborted();
    await storage.putObject(key, body, contentType, signal, etag);
  };
}
