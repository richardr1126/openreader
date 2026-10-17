'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

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
  // The plan whose idle seek layout is wanted. A fresh object per adoption lets
  // re-adopting the same plan id fetch again after a reset.
  const [idleLayoutPlan, setIdleLayoutPlan] = useState<{ planId: string } | null>(null);
  const requestedSeekLayoutKeyRef = useRef<string | null>(null);
  const resetBootstrapPlanAdoption = useCallback(() => {
    requestedSeekLayoutKeyRef.current = null;
    setIdleLayoutPlan(null);
  }, []);
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
  ): TtsPlaybackPlan => {
    const plan = assertAuthoritativePlaybackPlan(value, {
      documentId: request?.payload.documentId ?? value.documentId,
      readerType: activeReaderType,
    });
    const applied = applyPlaybackPlan(plan);
    if (plan.planId && plan.segments.length > 0) setIdleLayoutPlan({ planId: plan.planId });
    return applied;
  }, [
    activeReaderType,
    applyPlaybackPlan,
    request,
  ]);

  // A plan-only seek layout is immutable for one plan and playback request, so
  // it is fetched once per pair for the idle scrubber; session-owned layout
  // updates begin only after playback creates a session. It waits for the
  // request because the audio cache is keyed by the settings the session will
  // send, including a voice only the client resolves. Retrying could never
  // change the result and previously multiplied into a request storm.
  useEffect(() => {
    if (!idleLayoutPlan || !request) return;
    const { planId } = idleLayoutPlan;
    const key = `${planId}\0${JSON.stringify(request.payload)}`;
    if (requestedSeekLayoutKeyRef.current === key) return;
    requestedSeekLayoutKeyRef.current = key;
    void getTtsPlaybackSeekLayout(planId, request).then((layout) => {
      if (
        layout.durationMs > 0
        && layout.segments.length > 0
        && playbackPlanRef.current?.planId === planId
        && requestedSeekLayoutKeyRef.current === key
      ) {
        setPlaybackSeekLayout(layout);
      }
    }).catch(() => undefined);
  }, [idleLayoutPlan, playbackPlanRef, request, setPlaybackSeekLayout]);

  return {
    acceptBootstrapPlaybackPlan,
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    getPlaybackPlan,
    resetBootstrapPlanAdoption,
  };
}
