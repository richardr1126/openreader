'use client';

import { useCallback, type MutableRefObject } from 'react';

import { lookupAudiobook, startAudiobook, stopAudiobook, TtsExportRequestError } from '@/lib/client/api/tts';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import type { TtsPlaybackPlanRequest } from '@/hooks/audio/useTtsPlayback';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import type { Audiobook, TtsExportAction } from '@/types/tts-export';

export type TtsDocumentAudioExportRequest = {
  format: 'mp3' | 'm4b';
  speed: number;
  action: TtsExportAction;
  chapterIndex?: number;
  includeProgress?: boolean;
  /** The audiobook a stop applies to. */
  audiobookId?: string;
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
  ): Promise<Audiobook> => {
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

    const { documentId } = request.payload;
    const payload = {
      settings: request.payload.settings,
      ...(request.payload.planning ? { planning: request.payload.planning } : {}),
      planObjectKey: plan.planObjectKey,
      format: options.format,
      speed: options.speed,
      includeProgress: options.includeProgress,
      ...(options.chapterIndex === undefined ? {} : { chapter: options.chapterIndex }),
    };
    switch (options.action) {
      case 'start':
        return startAudiobook(documentId, payload, signal);
      case 'retry-skipped':
        return startAudiobook(documentId, { ...payload, retrySkipped: true }, signal);
      case 'stop':
        if (options.audiobookId) {
          try {
            return await stopAudiobook(documentId, options.audiobookId, signal);
          } catch (error) {
            // Its request already ended, so there is nothing left to stop.
            if (!(error instanceof TtsExportRequestError) || error.status !== 404) throw error;
          }
        }
        return lookupAudiobook(documentId, payload, signal);
      default:
        return lookupAudiobook(documentId, payload, signal);
    }
  }, [applyWorkerPlan, buildPlaybackPlanRequest, playbackPlanRef]);

  return { resolveDocumentAudioExport };
}
