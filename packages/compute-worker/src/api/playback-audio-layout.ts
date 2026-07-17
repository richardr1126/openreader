export {
  buildPlaybackCbrLayout as buildByteLayout,
  bytesForDurationMs,
  calibrateMsPerChar,
  DEFAULT_MS_PER_CHAR,
  estimateDurationMs,
  locateByte,
  parseRangeHeader,
  type PlanSlotInput,
} from '@openreader/tts/playback-cbr-layout';

export function resolvePlaybackStreamStartOrdinal(
  planOrdinals: number[],
  sessionStartOrdinal: unknown,
  requestedStartOrdinal?: unknown,
): number | null {
  const raw = requestedStartOrdinal === undefined
    ? sessionStartOrdinal
    : requestedStartOrdinal;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  const ordinal = Math.max(0, Math.floor(numeric));
  return planOrdinals.includes(ordinal) ? ordinal : null;
}
