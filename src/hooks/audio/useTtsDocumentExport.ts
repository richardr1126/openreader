'use client';

import { useCallback, type MutableRefObject } from 'react';

import { resolveTtsExport } from '@/lib/client/api/tts';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import type { TtsPlaybackPlanRequest } from '@/hooks/audio/useTtsPlayback';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { TtsExportAction, TtsExportResolveSnapshot } from '@/types/tts-export';

export type TtsDocumentAudioExportRequest = {
  format: 'mp3' | 'm4b';
  speed: number;
  action: TtsExportAction;
  chapterIndex?: number;
};

type UseTtsDocumentExportInput = {
  playbackPlanRef: MutableRefObject<TtsPlaybackPlan | null>;
  applyWorkerPlan: (plan: TtsPlaybackPlan) => CanonicalTtsSegment[];
  buildPlaybackPlanRequest: () => TtsPlaybackPlanRequest | null;
};

/** Binds audiobook export requests to the reader's adopted canonical plan. */
export function useTtsDocumentExport(input: UseTtsDocumentExportInput) {
  const {
    playbackPlanRef,
    applyWorkerPlan,
    buildPlaybackPlanRequest,
  } = input;

  const resolveDocumentAudioExport = useCallback(async (
    options: TtsDocumentAudioExportRequest,
    signal?: AbortSignal,
  ): Promise<TtsExportResolveSnapshot> => {
    const request = buildPlaybackPlanRequest();
    if (!request) {
      throw new Error('No document is ready for audio export.');
    }

    const plan = playbackPlanRef.current;
    if (!plan?.planObjectKey || plan.segments.length === 0) {
      throw new Error('The bootstrap playback plan is not ready for export.');
    }

    const canonicalPlan = applyWorkerPlan(plan);
    if (canonicalPlan.length === 0) {
      throw new Error('The worker playback plan was empty for export.');
    }

    return resolveTtsExport({
      documentId: request.payload.documentId,
      settings: request.payload.settings,
      ...(request.payload.planning ? { planning: request.payload.planning } : {}),
      startIntent: { selectedOrdinal: 0 },
      ...(plan.planId ? { planId: plan.planId } : {}),
      planObjectKey: plan.planObjectKey,
      ...(plan.planSignature ? { planSignature: plan.planSignature } : {}),
      generationExtent: 'document',
      format: options.format,
      speed: options.speed,
      action: options.action,
      ...(options.chapterIndex === undefined ? {} : { chapterIndex: options.chapterIndex }),
    }, request.headers, signal);
  }, [applyWorkerPlan, buildPlaybackPlanRequest, playbackPlanRef]);

  return { resolveDocumentAudioExport };
}
