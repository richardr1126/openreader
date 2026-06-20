import type { TTSSegmentLocator } from '@/types/client';
import type { TTSSentenceAlignment } from '@/types/tts';

export type TtsPlaybackTimelineSegment = {
  ordinal: number;
  sourceSegmentIndex?: number;
  segmentKey: string | null;
  segmentId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  locator: TTSSegmentLocator | null;
  alignment: TTSSentenceAlignment | null;
};

export type TtsPlaybackTimeline = {
  sessionId: string;
  documentId: string;
  status: string;
  startOrdinal: number;
  durationMs: number;
  segments: TtsPlaybackTimelineSegment[];
};

export type TtsPlaybackTimeProjection = {
  segment: TtsPlaybackTimelineSegment | null;
  segmentIndex: number;
  localTimeSec: number;
  wordIndex: number | null;
};

export function normalizePlaybackTimeline(value: unknown): TtsPlaybackTimeline {
  if (!value || typeof value !== 'object') {
    return {
      sessionId: '',
      documentId: '',
      status: 'unknown',
      startOrdinal: 0,
      durationMs: 0,
      segments: [],
    };
  }
  const rec = value as Record<string, unknown>;
  const rawSegments = Array.isArray(rec.segments) ? rec.segments : [];
  const segments = rawSegments
    .map((item): TtsPlaybackTimelineSegment | null => {
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
        ...(Number.isFinite(Number(row.sourceSegmentIndex))
          ? { sourceSegmentIndex: Math.max(0, Math.floor(Number(row.sourceSegmentIndex))) }
          : {}),
        segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
        segmentId: typeof row.segmentId === 'string' ? row.segmentId : '',
        startMs: Math.max(0, Math.floor(startMs)),
        endMs: Math.max(0, Math.floor(endMs)),
        durationMs: Number.isFinite(durationMs) && durationMs > 0
          ? Math.floor(durationMs)
          : Math.max(1, Math.floor(endMs - startMs)),
        locator: row.locator && typeof row.locator === 'object' ? row.locator as TTSSegmentLocator : null,
        alignment: row.alignment && typeof row.alignment === 'object' ? row.alignment as TTSSentenceAlignment : null,
      };
    })
    .filter((item): item is TtsPlaybackTimelineSegment => Boolean(item))
    .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);

  return {
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
    documentId: typeof rec.documentId === 'string' ? rec.documentId : '',
    status: typeof rec.status === 'string' ? rec.status : 'unknown',
    startOrdinal: Number.isFinite(Number(rec.startOrdinal)) ? Math.max(0, Math.floor(Number(rec.startOrdinal))) : 0,
    durationMs: Number.isFinite(Number(rec.durationMs)) ? Math.max(0, Math.floor(Number(rec.durationMs))) : 0,
    segments,
  };
}

export function findTimelineSegmentAtMs(
  segments: TtsPlaybackTimelineSegment[],
  timeMs: number,
): { segment: TtsPlaybackTimelineSegment; index: number } | null {
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

export function projectTimelineAtTime(
  timeline: TtsPlaybackTimeline,
  currentTimeSec: number,
  options?: { wordLeadSec?: number },
): TtsPlaybackTimeProjection {
  const currentTimeMs = Number.isFinite(currentTimeSec) ? currentTimeSec * 1000 : 0;
  const match = findTimelineSegmentAtMs(timeline.segments, currentTimeMs);
  if (!match) {
    return {
      segment: null,
      segmentIndex: -1,
      localTimeSec: 0,
      wordIndex: null,
    };
  }

  const localTimeSec = Math.max(0, (currentTimeMs - match.segment.startMs) / 1000);
  const wordLocalTimeSec = Math.max(0, localTimeSec + Math.max(0, options?.wordLeadSec ?? 0));
  return {
    segment: match.segment,
    segmentIndex: match.index,
    localTimeSec,
    wordIndex: resolveWordIndexAtTime(match.segment.alignment, wordLocalTimeSec),
  };
}
