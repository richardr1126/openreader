export interface FavoriteVoice {
  providerRef: string;
  ttsModel: string;
  voice: string;
}

export function favoriteVoiceKey(entry: FavoriteVoice): string {
  return JSON.stringify([entry.providerRef, entry.ttsModel, entry.voice]);
}

/** Keep unavailable entries: the live catalog is not the preference store. */
export function normalizeFavoriteVoices(input: unknown): FavoriteVoice[] {
  if (!Array.isArray(input)) return [];
  const entries = new Map<string, FavoriteVoice>();
  for (const value of input) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (![record.providerRef, record.ttsModel, record.voice]
      .every((field) => typeof field === 'string' && field.trim().length > 0 && field.length <= 2048)) continue;
    const entry = {
      providerRef: (record.providerRef as string).trim(),
      ttsModel: (record.ttsModel as string).trim(),
      voice: (record.voice as string).trim(),
    };
    entries.set(favoriteVoiceKey(entry), entry);
    if (entries.size === 500) break;
  }
  return [...entries.values()];
}

export function toggleFavoriteVoice(entries: FavoriteVoice[], entry: FavoriteVoice): FavoriteVoice[] {
  const key = favoriteVoiceKey(entry);
  return entries.some((value) => favoriteVoiceKey(value) === key)
    ? entries.filter((value) => favoriteVoiceKey(value) !== key)
    : normalizeFavoriteVoices([...entries, entry]);
}
