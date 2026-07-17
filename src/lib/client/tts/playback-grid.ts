import type { TTSSegmentLocator } from '@/types/client';
import type { TTSSentenceAlignment } from '@/types/tts';
import { normalizeLocator } from '@openreader/tts/locator';

export type TtsPlaybackGridSegment = {
  ordinal: number;
  segmentKey: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  audioState: 'pending' | 'ready' | 'generating' | 'error' | 'silent-gap' | 'missing-prefix';
  durationSource: 'estimated' | 'exact';
  generated: boolean;
  estimated: boolean;
  locator: TTSSegmentLocator | null;
  alignment: TTSSentenceAlignment | null;
};

export type TtsPlaybackGrid = {
  sessionId: string;
  documentId: string;
  status: string;
  startOrdinal: number;
  generationStartOrdinal: number;
  durationMs: number;
  segments: TtsPlaybackGridSegment[];
};

export type TtsPlaybackTimeProjection = {
  segment: TtsPlaybackGridSegment | null;
  gridIndex: number;
  localTimeSec: number;
  wordIndex: number | null;
};

export function mediaTimeToDocumentTime(mediaTimeSec: number, streamBaseSec: number): number {
  const media = Number.isFinite(mediaTimeSec) ? Math.max(0, mediaTimeSec) : 0;
  const base = Number.isFinite(streamBaseSec) ? Math.max(0, streamBaseSec) : 0;
  return base + media;
}

export function documentTimeToMediaTime(documentTimeSec: number, streamBaseSec: number): number {
  const documentTime = Number.isFinite(documentTimeSec) ? Math.max(0, documentTimeSec) : 0;
  const base = Number.isFinite(streamBaseSec) ? Math.max(0, streamBaseSec) : 0;
  return Math.max(0, documentTime - base);
}

export function normalizePlaybackGrid(value: unknown): TtsPlaybackGrid {
  if (!value || typeof value !== 'object') {
    return {
      sessionId: '',
      documentId: '',
      status: 'unknown',
      startOrdinal: 0,
      generationStartOrdinal: 0,
      durationMs: 0,
      segments: [],
    };
  }
  const rec = value as Record<string, unknown>;
  const rawSegments = Array.isArray(rec.segments) ? rec.segments : [];
  const segments = rawSegments
    .map((item): TtsPlaybackGridSegment | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const ordinal = Number(row.ordinal);
      const startMs = Number(row.startMs);
      const endMs = Number(row.endMs);
      const durationMs = Number(row.durationMs);
      if (!Number.isFinite(ordinal) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
      if (endMs <= startMs) return null;
      return {
        ordinal: Math.floor(ordinal),
        segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
        startMs: Math.max(0, Math.floor(startMs)),
        endMs: Math.max(0, Math.floor(endMs)),
        durationMs: Number.isFinite(durationMs) && durationMs > 0
          ? Math.floor(durationMs)
          : Math.max(1, Math.floor(endMs - startMs)),
        audioState: row.audioState === 'ready'
          || row.audioState === 'generating'
          || row.audioState === 'error'
          || row.audioState === 'silent-gap'
          || row.audioState === 'missing-prefix'
          ? row.audioState
          : row.generated === true ? 'ready' : 'pending',
        durationSource: row.durationSource === 'exact' || row.durationSource === 'estimated'
          ? row.durationSource
          : row.generated === true ? 'exact' : 'estimated',
        generated: row.generated === true || row.audioState === 'ready',
        estimated: row.estimated === true || row.durationSource === 'estimated',
        locator: row.locator && typeof row.locator === 'object'
          ? normalizeLocator(row.locator as TTSSegmentLocator)
          : null,
        alignment: row.alignment && typeof row.alignment === 'object' ? row.alignment as TTSSentenceAlignment : null,
      };
    })
    .filter((item): item is TtsPlaybackGridSegment => Boolean(item))
    .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);

  return {
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
    documentId: typeof rec.documentId === 'string' ? rec.documentId : '',
    status: typeof rec.status === 'string' ? rec.status : 'unknown',
    startOrdinal: Number.isFinite(Number(rec.startOrdinal)) ? Math.max(0, Math.floor(Number(rec.startOrdinal))) : 0,
    generationStartOrdinal: Number.isFinite(Number(rec.generationStartOrdinal))
      ? Math.max(0, Math.floor(Number(rec.generationStartOrdinal)))
      : Number.isFinite(Number(rec.startOrdinal)) ? Math.max(0, Math.floor(Number(rec.startOrdinal))) : 0,
    durationMs: Number.isFinite(Number(rec.durationMs)) ? Math.max(0, Math.floor(Number(rec.durationMs))) : 0,
    segments,
  };
}

export function findPlaybackGridSegmentAtMs(
  segments: TtsPlaybackGridSegment[],
  timeMs: number,
): { segment: TtsPlaybackGridSegment; index: number } | null {
  if (segments.length === 0 || !Number.isFinite(timeMs)) return null;
  const clampedTimeMs = Math.max(0, timeMs);
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const segment = segments[mid];
    if (clampedTimeMs < segment.startMs) {
      high = mid - 1;
    } else if (clampedTimeMs >= segment.endMs) {
      low = mid + 1;
    } else {
      return { segment, index: mid };
    }
  }

  const last = segments[segments.length - 1];
  if (clampedTimeMs >= last.endMs) {
    return { segment: last, index: segments.length - 1 };
  }
  return null;
}

export function resolveWordIndexAtTime(
  alignment: TTSSentenceAlignment | null | undefined,
  localTimeSec: number,
): number | null {
  if (!alignment || !Array.isArray(alignment.words) || alignment.words.length === 0) return null;
  if (!Number.isFinite(localTimeSec)) return null;
  let index = -1;
  for (let i = 0; i < alignment.words.length; i += 1) {
    const word = alignment.words[i];
    if (localTimeSec >= word.startSec && localTimeSec < word.endSec) {
      index = i;
      break;
    }
    if (localTimeSec >= word.startSec) {
      index = i;
    }
  }
  return index >= 0 ? index : null;
}

export function projectPlaybackGridAtTime(
  timeline: TtsPlaybackGrid,
  currentTimeSec: number,
  options?: { wordLeadSec?: number },
): TtsPlaybackTimeProjection {
  const currentTimeMs = Number.isFinite(currentTimeSec) ? currentTimeSec * 1000 : 0;
  const match = findPlaybackGridSegmentAtMs(timeline.segments, currentTimeMs);
  if (!match) {
    return {
      segment: null,
      gridIndex: -1,
      localTimeSec: 0,
      wordIndex: null,
    };
  }

  const localTimeSec = Math.max(0, (currentTimeMs - match.segment.startMs) / 1000);
  const wordLocalTimeSec = Math.max(0, localTimeSec + Math.max(0, options?.wordLeadSec ?? 0));
  return {
    segment: match.segment,
    gridIndex: match.index,
    localTimeSec,
    wordIndex: resolveWordIndexAtTime(match.segment.alignment, wordLocalTimeSec),
  };
}
