'use client';

import { useCallback, useEffect, type MutableRefObject } from 'react';

import {
  createTtsPlaybackPlan,
  getTtsPlaybackSeekLayout,
  type TtsPlaybackSeekLayout,
} from '@/lib/client/api/tts';
import {
  normalizePlaybackPlan,
  type TtsPlaybackPlan,
} from '@/lib/client/tts/playback-plan';
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
  isPlaying: boolean;
  playbackAnchor: PlaybackAnchor | null;
  playbackAnchorRef: MutableRefObject<PlaybackAnchor | null>;
  playbackPlanRef: MutableRefObject<TtsPlaybackPlan | null>;
  playbackPlanSource: 'idle' | 'worker';
  playbackSeekLayout: TtsPlaybackSeekLayout | null;
  request: TtsPlaybackPlanRequest | null;
  selectedOrdinalRef: MutableRefObject<number | null>;
  applyWorkerPlan: (plan: TtsPlaybackPlan) => CanonicalTtsSegment[];
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
};

export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort|cancel/i.test(error.message || '');
  }
  if (typeof error === 'string') return /abort|cancel/i.test(error);
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && /abort|cancel/i.test(message);
  }
  return false;
}

export function useTtsPlanController(input: UseTtsPlanControllerInput) {
  const {
    activeReaderType,
    currentLocation,
    currentPdfPage,
    isPlaying,
    playbackAnchor,
    playbackAnchorRef,
    playbackPlanRef,
    playbackPlanSource,
    playbackSeekLayout,
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

  const fetchPlaybackPlanUntilReady = useCallback(async (
    planUrl: string,
    signal?: AbortSignal,
  ): Promise<TtsPlaybackPlan | null> => {
    const fetchPlan = async () => {
      const response = await fetch(planUrl, { cache: 'no-store', signal });
      if (!response.ok) return null;
      return normalizePlaybackPlan(await response.json());
    };
    let plan = await fetchPlan();
    for (let attempt = 0; (!plan || plan.segments.length === 0) && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (signal?.aborted) return null;
      plan = await fetchPlan();
    }
    return plan && plan.segments.length > 0 ? plan : null;
  }, []);

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
      throw new Error('TTS playback plan did not contain a plan-backed selection for the current anchor');
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

  const ensurePlaybackPlan = useCallback(async (
    planRequest: TtsPlaybackPlanRequest,
    signal?: AbortSignal,
  ): Promise<TtsPlaybackPlan | null> => {
    const existing = playbackPlanRef.current;
    if (existing?.planObjectKey && existing.segments.length > 0) {
      if (existing.planId && !playbackSeekLayout) {
        const layout = await fetchPlaybackSeekLayoutUntilReady(
          `/api/tts/playback/plans/${encodeURIComponent(existing.planId)}/seek-layout`,
          signal,
        );
        if (!signal?.aborted && layout) setPlaybackSeekLayout(layout);
      }
      return existing;
    }

    const planHandle = await createTtsPlaybackPlan(planRequest.payload, planRequest.headers, signal);
    const plan = await fetchPlaybackPlanUntilReady(planHandle.planUrl, signal);
    if (!plan) return null;
    const layout = await fetchPlaybackSeekLayoutUntilReady(planHandle.seekLayoutUrl, signal);
    if (!signal?.aborted && layout) setPlaybackSeekLayout(layout);
    return plan;
  }, [
    fetchPlaybackPlanUntilReady,
    fetchPlaybackSeekLayoutUntilReady,
    playbackPlanRef,
    playbackSeekLayout,
    setPlaybackSeekLayout,
  ]);

  const createAndApplyPlaybackPlan = useCallback(async (
    planRequest: TtsPlaybackPlanRequest,
    signal?: AbortSignal,
  ): Promise<TtsPlaybackPlan | null> => {
    const plan = await ensurePlaybackPlan(planRequest, signal);
    return plan ? applyPlaybackPlan(plan) : null;
  }, [applyPlaybackPlan, ensurePlaybackPlan]);

  useEffect(() => {
    if (isPlaying || playbackPlanSource === 'worker') return;
    if (!playbackAnchor?.hasContent && !playbackAnchor?.text.trim()) return;
    const planRequest = buildPlaybackPlanRequest();
    if (!planRequest) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const plan = await ensurePlaybackPlan(planRequest, controller.signal);
        if (!controller.signal.aborted && plan) applyPlaybackPlan(plan);
      } catch (error) {
        if (controller.signal.aborted || isAbortLikeError(error)) return;
        console.warn('Failed to prefetch TTS playback plan:', error);
      }
    })();

    return () => controller.abort();
  }, [
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    ensurePlaybackPlan,
    isPlaying,
    playbackAnchor,
    playbackPlanSource,
  ]);

  return {
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
    ensurePlaybackPlan,
  };
}
