import { catalogVoiceName } from '@openreader/tts/provider-catalog';
import type { AudiobookCaller } from '@/lib/server/audiobooks/audiobooks';
import { loadSavedPlayback } from '@/lib/server/audiobooks/request';
import { ComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { resolveDefaultPlaybackRequest } from '@/lib/server/reader/playback';
import { buildTtsPlaybackPlanningInput } from '@/lib/server/tts/playback-request';
import type { CachedVoiceResource } from '@/types/voice-api';
import { listClonedVoices } from './cloned-voices';

type CachedSettings = { providerRef?: unknown; ttsModel?: unknown; voice?: unknown; nativeSpeed?: unknown };

/**
 * The voices this document has segment audio for that a request naming them
 * would reuse. A variant counts only when building the request for its voice
 * and model speed from today's saved settings gives the same audio cache, so a
 * changed segment length, instruction or disabled provider leaves it out.
 */
export async function listCachedVoices(caller: AudiobookCaller, documentId: string): Promise<CachedVoiceResource[] | Response> {
  const { scope } = caller;
  const variants = await new ComputeWorkerClient().listTtsPlaybackCachedVariants({
    storageUserId: scope.storageUserId,
    documentId,
    documentVersion: scope.documentVersion,
  });
  if (variants.length === 0) return [];
  const saved = await loadSavedPlayback(caller, documentId, { observeOnly: true });
  if (saved instanceof Response) return saved;
  const clones = variants.some(({ settingsJson }) => String((settingsJson as CachedSettings).voice).startsWith('clone:'))
    ? await listClonedVoices(scope.userId) : [];

  const voices: CachedVoiceResource[] = [];
  for (const variant of variants) {
    const cached = variant.settingsJson as CachedSettings;
    if (typeof cached.providerRef !== 'string' || typeof cached.ttsModel !== 'string' || typeof cached.voice !== 'string') continue;
    const modelSpeed = Number(cached.nativeSpeed) || 1;
    const request = await resolveDefaultPlaybackRequest(documentId, scope, saved.settings, saved.preferences, saved.language, {
      provider: cached.providerRef,
      model: cached.ttsModel,
      voice: cached.voice,
      modelSpeed,
    });
    if ('error' in request) continue;
    const { settingsHash } = await buildTtsPlaybackPlanningInput(request, scope);
    if (settingsHash !== variant.settingsHash) continue;
    const voice = cached.voice;
    voices.push({
      provider: cached.providerRef,
      model: cached.ttsModel,
      voice,
      name: clones.find(({ id }) => id === voice)?.name ?? catalogVoiceName(voice),
      modelSpeed,
      segments: variant.segments,
      durationMs: variant.durationMs,
      updatedAt: variant.updatedAt,
    });
  }
  return voices;
}
