import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TTSSegmentLocator } from '@/types/client';

/**
 * One entry of the worker-persisted canonical plan artifact. The plan is the
 * authoritative, ordered segment list (text + locator + key) the worker
 * generated against; the client drives its UI (sentence list / sidebar /
 * current index) from this, with timing supplied separately by the timeline.
 */
export type TtsPlaybackPlanSegment = {
  segmentIndex: number;
  segmentKey: string | null;
  text: string;
  locator: TTSSegmentLocator | null;
};

export type TtsPlaybackPlan = {
  sessionId: string;
  documentId: string;
  readerType: string;
  segments: TtsPlaybackPlanSegment[];
};

export function normalizePlaybackPlan(value: unknown): TtsPlaybackPlan {
  const empty: TtsPlaybackPlan = { sessionId: '', documentId: '', readerType: '', segments: [] };
  if (!value || typeof value !== 'object') return empty;
  const rec = value as Record<string, unknown>;
  const rawSegments = Array.isArray(rec.segments) ? rec.segments : [];
  const segments = rawSegments
    .map((item): TtsPlaybackPlanSegment | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const text = typeof row.text === 'string' ? row.text : '';
      if (!text.trim()) return null;
      return {
        segmentIndex: Number.isFinite(Number(row.segmentIndex)) ? Math.max(0, Math.floor(Number(row.segmentIndex))) : 0,
        segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
        text,
        locator: row.locator && typeof row.locator === 'object' ? row.locator as TTSSegmentLocator : null,
      };
    })
    .filter((item): item is TtsPlaybackPlanSegment => Boolean(item));

  return {
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
    documentId: typeof rec.documentId === 'string' ? rec.documentId : '',
    readerType: typeof rec.readerType === 'string' ? rec.readerType : '',
    segments,
  };
}

/**
 * Project the plan into the `CanonicalTtsSegment[]` shape the reader UI consumes
 * for `playbackSegments`. Ordinal is the segment's **absolute** canonical position
 * from the worker (the plan spans the whole document, so this also equals the
 * array index — but we use the server value so the mapping stays correct even if
 * the plan is ever delivered as a window). Anchors carry the locator's `charOffset`
 * so EPUB highlighting can map back into the spine text.
 */
export function playbackPlanToCanonicalSegments(plan: TtsPlaybackPlan): CanonicalTtsSegment[] {
  return plan.segments.map((segment) => {
    const charOffset = segment.locator?.charOffset ?? 0;
    const sourceKey = segment.segmentKey ?? `plan:${segment.segmentIndex}`;
    return {
      key: segment.segmentKey ?? `plan:${segment.segmentIndex}`,
      ordinal: segment.segmentIndex,
      text: segment.text,
      ownerSourceKey: sourceKey,
      ownerLocator: segment.locator,
      startAnchor: { sourceKey, offset: charOffset },
      endAnchor: { sourceKey, offset: charOffset + segment.text.length },
      spansSourceBoundary: false,
    };
  });
}
