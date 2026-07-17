'use client';

import { useCallback, type MutableRefObject } from 'react';

import { resolveTtsExport } from '@/lib/client/api/tts';
import type { TtsPlaybackPlan } from '@/lib/client/tts/playback-plan';
import type { TtsPlaybackPlanRequest } from '@/hooks/audio/useTtsPlayback';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

export type TtsDocumentAudioExportResolution = {
  sessionId: string;
  artifactId: string;
  downloadUrl: string | null;
  generationOperationId: string | null;
  artifactOperationId: string | null;
  generationStatus: string | null;
  artifactStatus: string | null;
  seekLayoutUrl: string;
  plannedCount: number;
  completedCount: number | null;
};

type UseTtsDocumentExportInput = {
  playbackPlanRef: MutableRefObject<TtsPlaybackPlan | null>;
  applyWorkerPlan: (plan: TtsPlaybackPlan) => CanonicalTtsSegment[];
  buildPlaybackPlanRequest: () => TtsPlaybackPlanRequest | null;
  ensurePlaybackPlan: (
    request: TtsPlaybackPlanRequest,
    signal?: AbortSignal,
  ) => Promise<TtsPlaybackPlan | null>;
};

export function useTtsDocumentExport(input: UseTtsDocumentExportInput) {
  const {
    playbackPlanRef,
    applyWorkerPlan,
    buildPlaybackPlanRequest,
    ensurePlaybackPlan,
  } = input;

  const resolveDocumentAudioExportInternal = useCallback(async (
    options: { format: 'mp3' | 'm4b'; speed: number },
    start: boolean,
    signal?: AbortSignal,
  ): Promise<TtsDocumentAudioExportResolution> => {
    const request = buildPlaybackPlanRequest();
    if (!request) {
      throw new Error('No document is ready for audio export.');
    }

    const existingPlan = playbackPlanRef.current;
    const plan = existingPlan?.planObjectKey && existingPlan.segments.length > 0
      ? existingPlan
      : await ensurePlaybackPlan(request, signal);
    if (!plan?.planObjectKey || plan.segments.length === 0) {
      throw new Error('The worker playback plan was not ready for export.');
    }

    const canonicalPlan = applyWorkerPlan(plan);
    if (canonicalPlan.length === 0) {
      throw new Error('The worker playback plan was empty for export.');
    }

    const snapshot = await resolveTtsExport({
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
      start,
    }, request.headers, signal);

    const plannedCount = plan.plannedCount ?? plan.segments.length;
    const generationProgress = snapshot.generation.progress ?? snapshot.generation.operation?.progress ?? null;
    const progressCompletedCount = generationProgress && Number.isFinite(Number(generationProgress.completedCount))
      ? Math.max(0, Math.floor(Number(generationProgress.completedCount)))
      : generationProgress && Number.isFinite(Number(generationProgress.completedThroughOrdinal))
        ? Math.max(0, Math.floor(Number(generationProgress.completedThroughOrdinal)) + 1)
        : null;
    const generationStatus = snapshot.generation.operation?.status ?? snapshot.generation.session?.status ?? null;
    const artifactStatus = snapshot.artifact.artifact ? 'succeeded' : snapshot.artifact.operation?.status ?? null;
    const completedCount = snapshot.downloadUrl || artifactStatus === 'succeeded' || generationStatus === 'succeeded'
      ? plannedCount
      : progressCompletedCount === null
        ? null
        : Math.min(plannedCount, progressCompletedCount);

    return {
      sessionId: snapshot.sessionId,
      artifactId: snapshot.artifactId,
      downloadUrl: snapshot.downloadUrl,
      generationOperationId: snapshot.generation.operation?.opId ?? null,
      artifactOperationId: snapshot.artifact.operation?.opId ?? null,
      generationStatus,
      artifactStatus,
      seekLayoutUrl: plan.planId
        ? `/api/tts/playback/plans/${encodeURIComponent(plan.planId)}/seek-layout?sessionId=${encodeURIComponent(snapshot.sessionId)}`
        : '',
      plannedCount,
      completedCount,
    };
  }, [applyWorkerPlan, buildPlaybackPlanRequest, ensurePlaybackPlan, playbackPlanRef]);

  const resolveDocumentAudioExport = useCallback((
    options: { format: 'mp3' | 'm4b'; speed: number },
    signal?: AbortSignal,
  ) => resolveDocumentAudioExportInternal(options, false, signal), [resolveDocumentAudioExportInternal]);

  const startDocumentAudioExport = useCallback((
    options: { format: 'mp3' | 'm4b'; speed: number },
    signal?: AbortSignal,
  ) => resolveDocumentAudioExportInternal(options, true, signal), [resolveDocumentAudioExportInternal]);

  return { resolveDocumentAudioExport, startDocumentAudioExport };
}
