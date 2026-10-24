/** Null preserves the engine's released behavior; zero explicitly adds no silence. */
export interface VoiceCustomization {
  pieceCharacterLimit: number | null;
  piecePauseMilliseconds: number | null;
  blockPauseMilliseconds: number | null;
}

export const VOICE_CUSTOMIZATION_FIELDS = ['pieceCharacterLimit', 'piecePauseMilliseconds', 'blockPauseMilliseconds'] as const;
export const AUTOMATIC_VOICE_CUSTOMIZATION: VoiceCustomization = {
  pieceCharacterLimit: null, piecePauseMilliseconds: null, blockPauseMilliseconds: null,
};

export function normalizeVoiceCustomizationOverride(value: unknown): Partial<VoiceCustomization> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: Partial<VoiceCustomization> = {};
  for (const key of VOICE_CUSTOMIZATION_FIELDS) {
    const candidate = record[key];
    if (candidate === null) result[key] = null;
    else if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      result[key] = key === 'pieceCharacterLimit'
        ? Math.min(450, Math.max(50, Math.round(candidate)))
        : Math.min(2000, Math.max(0, Math.round(candidate)));
    }
  }
  return result;
}

export function normalizeVoiceCustomization(value: unknown): VoiceCustomization {
  return { ...AUTOMATIC_VOICE_CUSTOMIZATION, ...normalizeVoiceCustomizationOverride(value) };
}

/** External services own their internal splits. Neither their limits nor natural pauses are changed. */
export function effectiveVoiceCustomization(value: unknown, providerType: string): VoiceCustomization {
  const normalized = normalizeVoiceCustomization(value);
  return providerType === 'kokoro-local' ? normalized : {
    ...AUTOMATIC_VOICE_CUSTOMIZATION, blockPauseMilliseconds: normalized.blockPauseMilliseconds,
  };
}

/** All current web engines add zero fixed silence automatically. Keep that path's original keys. */
export function voiceCustomizationCacheKey(value: unknown, providerType: string): object | undefined {
  const settings = effectiveVoiceCustomization(value, providerType);
  const fields = Object.fromEntries(Object.entries(settings).filter(([key, entry]) =>
    entry !== null && (key === 'pieceCharacterLimit' || entry !== 0)));
  return Object.keys(fields).length ? { version: 1, ...fields } : undefined;
}

/** Estimated pending-slot padding; the stream length allows a join at every source character. */
export function estimateAddedPauseMs(text: string, value: unknown, providerType: string, upperBound = false): number {
  const settings = effectiveVoiceCustomization(value, providerType);
  const tail = settings.blockPauseMilliseconds ?? 0;
  const pieces = upperBound ? Math.max(1, Array.from(text).length)
    : Math.max(1, Math.ceil(Array.from(text).length / (settings.pieceCharacterLimit ?? 450)));
  return tail + (pieces - 1) * (settings.piecePauseMilliseconds ?? 0) + (upperBound && tail > 0 ? 26 : 0);
}
