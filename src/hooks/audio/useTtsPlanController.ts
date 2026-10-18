'use client';

import { useCallback, type MutableRefObject } from 'react';

import {
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

  const acceptBootstrapPlaybackPlan = useCallback((
    value: TtsPlaybackPlan,
    seekLayout: TtsPlaybackSeekLayout,
  ): TtsPlaybackPlan => {
    const plan = assertAuthoritativePlaybackPlan(value, {
      documentId: request?.payload.documentId ?? value.documentId,
      readerType: activeReaderType,
    });
    if (seekLayout.planId !== plan.planId || seekLayout.segments.length !== plan.segments.length) {
      throw new Error('The initial audio timeline does not match the reading plan');
    }
    const applied = applyPlaybackPlan(plan);
    setPlaybackSeekLayout(seekLayout);
    return applied;
  }, [
    activeReaderType,
    applyPlaybackPlan,
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
