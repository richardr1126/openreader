import type { JobAttempt } from '../operations/types';
import { isPreconditionFailed, type ArtifactStorage } from '../infrastructure/storage';

export async function publishOrAdoptArtifact<T>(
  publish: () => Promise<unknown>,
  readWinner: () => Promise<T | null>,
  attempt?: JobAttempt,
): Promise<T | null> {
  try {
    await publish();
    return null;
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    await attempt?.assertActive();
    const winner = await readWinner();
    if (winner === null) throw error;
    return winner;
  }
}

/** Capture the object revision before compute and check ownership before the write. */
export async function prepareArtifactWrite(storage: ArtifactStorage, key: string, attempt?: JobAttempt) {
  const signal = attempt?.signal;
  const etag = attempt ? await storage.getObjectEtag?.(key, signal) : undefined;
  return async (body: Buffer | Uint8Array, contentType: string, metadata?: Record<string, string>): Promise<void> => {
    await attempt?.assertActive();
    signal?.throwIfAborted();
    if (metadata) await storage.putObject(key, body, contentType, signal, etag, metadata);
    else await storage.putObject(key, body, contentType, signal, etag);
  };
}
