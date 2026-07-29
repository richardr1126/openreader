'use client';

import { useCallback, type MutableRefObject } from 'react';

import {
  getTtsPlaybackSeekLayout,
  type TtsPlaybackSeekLayout,
} from '@/lib/client/api/tts';
import {
  assertAuthoritativePlaybackPlan,
  type TtsPlaybackPlan,
} from '@/lib/shared/playback-plan';
import {
  resolvePlanBackedSelectionIndex,
  resolvePlaybackAnchorLocation,
  type PlaybackAnchor,
} from '@/lib/client/tts/playback-selection';
import type { TTSLocation } from '@/types/tts';
import type { ReaderType } from '@/types/user-state';
import type {
  TtsPlaybackPlanRequest,
  TtsPlaybackSessionRequest,
} from '@/hooks/audio/useTtsPlayback';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

type UseTtsPlanControllerInput = {
  activeReaderType: ReaderType;
  currentLocation: TTSLocation;
  currentPdfPage: number;
  playbackAnchorRef: MutableRefObject<PlaybackAnchor | null>;
  playbackPlanRef: MutableRefObject<TtsPlaybackPlan | null>;
  request: TtsPlaybackPlanRequest | null;
  selectedOrdinalRef: MutableRefObject<number | null>;
  applyWorkerPlan: (plan: TtsPlaybackPlan) => CanonicalTtsSegment[];
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
};

export function useTtsPlanController(input: UseTtsPlanControllerInput) {
  const {
    activeReaderType,
    currentLocation,
    currentPdfPage,
    playbackAnchorRef,
    playbackPlanRef,
    request,
    selectedOrdinalRef,
    applyWorkerPlan,
    setPlaybackSeekLayout,
    setSelectedOrdinal,
  } = input;
  const buildPlaybackPlanRequest = useCallback(
    (): TtsPlaybackPlanRequest | null => request,
    [request],
  );

  const buildPlaybackSessionRequest = useCallback((): TtsPlaybackSessionRequest | null => {
    const planRequest = buildPlaybackPlanRequest();
    const ordinal = selectedOrdinalRef.current;
    if (!planRequest || ordinal === null || !Number.isFinite(ordinal)) return null;
    return {
      ...planRequest,
      selectedOrdinal: Math.max(0, Math.floor(ordinal)),
    };
  }, [buildPlaybackPlanRequest, selectedOrdinalRef]);

  const fetchPlaybackSeekLayoutUntilReady = useCallback(async (
    seekLayoutUrl: string,
    signal?: AbortSignal,
  ): Promise<TtsPlaybackSeekLayout | null> => {
    const fetchLayout = async () => {
      const layout = await getTtsPlaybackSeekLayout(seekLayoutUrl, signal).catch(() => null);
      return layout && layout.durationMs > 0 && layout.segments.length > 0 ? layout : null;
    };

    let layout = await fetchLayout();
    for (let attempt = 0; !layout && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (signal?.aborted) return null;
      layout = await fetchLayout();
    }
    return layout;
  }, []);

  const applyPlaybackPlan = useCallback((plan: TtsPlaybackPlan): TtsPlaybackPlan => {
    const canonicalPlan = applyWorkerPlan(plan);
    if (canonicalPlan.length === 0) {
      setSelectedOrdinal(null);
      return plan;
    }
    const startPlanIndex = resolvePlanBackedSelectionIndex({
      plan: canonicalPlan,
      readerType: activeReaderType,
      selectedOrdinal: selectedOrdinalRef.current,
      anchorLocation: resolvePlaybackAnchorLocation({
        anchor: playbackAnchorRef.current,
        readerType: activeReaderType,
        currentLocation,
        currentPdfPage,
      }),
    });
    const startSegment = canonicalPlan[startPlanIndex];
    if (!startSegment) {
      // EPUB cannot provide a stable rendered locator until its first rendition
      // commits. The authoritative plan is still ready; the renderer will
      // establish the plan-backed selection before the reader gate opens.
      setSelectedOrdinal(null);
      return plan;
    }
    setSelectedOrdinal(startSegment.ordinal);
    return plan;
  }, [
    activeReaderType,
    applyWorkerPlan,
    currentLocation,
    currentPdfPage,
    playbackAnchorRef,
    selectedOrdinalRef,
    setSelectedOrdinal,
  ]);

  const getPlaybackPlan = useCallback((): TtsPlaybackPlan | null => {
    const existing = playbackPlanRef.current;
    if (!existing?.planObjectKey) return null;
    return assertAuthoritativePlaybackPlan(existing, {
      documentId: request?.payload.documentId ?? existing.documentId,
      readerType: activeReaderType,
    });
  }, [
    activeReaderType,
    playbackPlanRef,
    request,
  ]);

  const acceptBootstrapPlaybackPlan = useCallback(async (
    value: TtsPlaybackPlan,
  ): Promise<TtsPlaybackPlan> => {
    const plan = assertAuthoritativePlaybackPlan(value, {
      documentId: request?.payload.documentId ?? value.documentId,
      readerType: activeReaderType,
    });
    const applied = applyPlaybackPlan(plan);
    if (plan.planId && plan.segments.length > 0) {
      const planId = plan.planId;
      void fetchPlaybackSeekLayoutUntilReady(
        `/api/tts/playback/plans/${encodeURIComponent(planId)}/seek-layout`,
      ).then((layout) => {
        if (layout && playbackPlanRef.current?.planId === planId) {
          setPlaybackSeekLayout(layout);
        }
      });
    }
    return applied;
  }, [
    activeReaderType,
    applyPlaybackPlan,
    fetchPlaybackSeekLayoutUntilReady,
    playbackPlanRef,
    request,
    setPlaybackSeekLayout,
  ]);

  return {
    acceptBootstrapPlaybackPlan,
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    getPlaybackPlan,
  };
}
