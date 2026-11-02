import type { ArtifactStorage } from '../infrastructure/storage';
import { getTtsCredentialBrokerConfig } from '../infrastructure/credential-broker-config';
import { ttsPlaybackExportArtifactScopePrefix } from './artifact-addressing';
import { storageUserHash } from './prefix-cleanup';

type Scope = { storageUserId: string; documentId: string };
type Input = Scope & { storage: ArtifactStorage; s3Prefix: string; logger?: { warn?: (data: unknown, message?: string) => void } };

async function broker(body: Record<string, unknown>): Promise<{ revision: number | null }> {
  const config = getTtsCredentialBrokerConfig();
  const response = await fetch(new URL('/api/internal/compute/storage', config.url), {
    method: 'POST', redirect: 'error', cache: 'no-store',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Storage usage broker rejected request (${response.status})`);
  return response.json();
}

/** No object budget or metadata reads: page through just this document, in bounded memory. */
export async function measureDocumentAudioBytes(input: Input): Promise<number> {
  const { storage, s3Prefix, storageUserId, documentId } = input;
  let bytes = 0;
  for (const prefix of [
    `${s3Prefix}/tts_playback_segments_audio_v1/users/${encodeURIComponent(storageUserId)}/docs/${documentId}/`,
    `${s3Prefix}/tts_playback_segments_v1/users/${storageUserHash(storageUserId)}/docs/${documentId}/`,
    `${ttsPlaybackExportArtifactScopePrefix({ storageUserId, prefix: s3Prefix })}docs/${documentId}/`,
  ]) for await (const page of storage.listPrefixPages(prefix)) for (const object of page) bytes += object.size;
  if (!Number.isSafeInteger(bytes)) throw new Error('Audio storage total exceeds the supported range');
  return bytes;
}

export function createDocumentAudioReporter(input: Input) {
  let lastMeasuredAt = 0;
  let pending: Promise<void> | null = null;
  const scope = { userId: input.storageUserId, documentId: input.documentId };
  const report = async (revision: number) => broker({ action: 'report', ...scope, revision, audioBytes: await measureDocumentAudioBytes(input) });
  const measure = async (force = false, strict = false): Promise<void> => {
    if (pending) { await pending; if (!force) return; }
    if (!force && Date.now() - lastMeasuredAt < 10_000) return;
    lastMeasuredAt = Date.now();
    pending = (async () => {
      const { revision } = await broker({ action: 'begin', ...scope });
      if (revision !== null) await report(revision);
    })().catch((error) => {
      input.logger?.warn?.({ error: String(error), documentId: input.documentId }, 'storage.usage_report_failed');
      if (strict) throw error;
    });
    try { await pending; } finally { pending = null; }
  };
  const clear = async <T>(run: () => Promise<T>): Promise<T> => {
    // A failed begin prevents deletion: the SQL fence must exist first.
    const { revision } = await broker({ action: 'begin-clear', ...scope });
    try { return await run(); }
    finally { if (revision !== null) await report(revision); }
  };
  return { measure, clear };
}
