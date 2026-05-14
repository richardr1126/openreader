export type WarmAudioLike = {
  pause?: () => void;
  removeAttribute?: (qualifiedName: string) => void;
  load?: () => void;
  src?: string;
};

export type WarmAudioCacheEntry = {
  key: string;
  url: string;
  audio: WarmAudioLike;
  warmedAt: number;
};

type UpsertWarmAudioEntryParams = {
  key: string;
  url: string;
  cache: Map<string, WarmAudioCacheEntry>;
  createAudio: (url: string) => WarmAudioLike;
  maxEntries: number;
  nowMs?: number;
};

export function releaseWarmAudio(audio: WarmAudioLike): void {
  try {
    audio.pause?.();
  } catch {
    // Ignore media pause errors during teardown.
  }
  try {
    audio.removeAttribute?.('src');
  } catch {
    // Ignore source cleanup errors.
  }
  try {
    if (!audio.removeAttribute && 'src' in audio) {
      audio.src = '';
    }
  } catch {
    // Ignore source cleanup errors.
  }
  try {
    audio.load?.();
  } catch {
    // Ignore media reload errors during teardown.
  }
}

export function upsertWarmAudioEntry({
  key,
  url,
  cache,
  createAudio,
  maxEntries,
  nowMs,
}: UpsertWarmAudioEntryParams): WarmAudioCacheEntry {
  const now = nowMs ?? Date.now();
  const existing = cache.get(key);
  if (existing && existing.url === url) {
    existing.warmedAt = now;
    return existing;
  }
  if (existing) {
    releaseWarmAudio(existing.audio);
    cache.delete(key);
  }

  const entry: WarmAudioCacheEntry = {
    key,
    url,
    audio: createAudio(url),
    warmedAt: now,
  };
  cache.set(key, entry);

  while (cache.size > maxEntries) {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [candidateKey, candidate] of cache.entries()) {
      if (candidate.warmedAt < oldestTime) {
        oldestTime = candidate.warmedAt;
        oldestKey = candidateKey;
      }
    }
    if (!oldestKey) break;
    const oldest = cache.get(oldestKey);
    if (oldest) {
      releaseWarmAudio(oldest.audio);
      cache.delete(oldestKey);
    }
  }

  return entry;
}
