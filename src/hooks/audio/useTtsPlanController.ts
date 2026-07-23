'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import {
  createTtsPlaybackPlan,
  getTtsPlaybackSeekLayout,
  resolveTtsPlaybackPlan,
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
  playbackSeekLayout: TtsPlaybackSeekLayout | null;
  request: TtsPlaybackPlanRequest | null;
  selectedOrdinalRef: MutableRefObject<number | null>;
  applyWorkerPlan: (plan: TtsPlaybackPlan) => CanonicalTtsSegment[];
  resetPlaybackPlan: (options?: { resetSelection?: boolean; resetSeekLayout?: boolean }) => void;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
};

export type PlaybackPlanLifecycle = {
  status: 'idle' | 'queued' | 'running' | 'ready' | 'failed';
  error: Error | null;
};

const IDLE_PLAN_LIFECYCLE: PlaybackPlanLifecycle = { status: 'idle', error: null };

export function useTtsPlanController(input: UseTtsPlanControllerInput) {
  const {
    activeReaderType,
    currentLocation,
    currentPdfPage,
    playbackAnchorRef,
    playbackPlanRef,
    playbackSeekLayout,
    request,
    selectedOrdinalRef,
    applyWorkerPlan,
    resetPlaybackPlan,
    setPlaybackSeekLayout,
    setSelectedOrdinal,
  } = input;
  const [planLifecycle, setPlanLifecycle] = useState<PlaybackPlanLifecycle>(IDLE_PLAN_LIFECYCLE);
  const requestKey = useMemo(() => request ? JSON.stringify(request) : '', [request]);
  const preparedRequestKeyRef = useRef('');
  const requestKeyRef = useRef(requestKey);
  const lifecycleRequestKeyRef = useRef('');
  // Page effects may request preparation before this controller's passive
  // effects run. Publish the render's request identity immediately so that a
  // new document can never start under the previous document's key.
  requestKeyRef.current = requestKey;
  useEffect(() => {
    const preparedKey = preparedRequestKeyRef.current;
    const preparedChanged = Boolean(preparedKey && preparedKey !== requestKey);
    const lifecycleChanged = Boolean(
      lifecycleRequestKeyRef.current
      && lifecycleRequestKeyRef.current !== requestKey,
    );
    if (!preparedChanged && !lifecycleChanged) return;
    preparedRequestKeyRef.current = '';
    lifecycleRequestKeyRef.current = '';
    resetPlaybackPlan({ resetSelection: false });
    setPlanLifecycle(IDLE_PLAN_LIFECYCLE);
  }, [requestKey, resetPlaybackPlan]);

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
    expected: { documentId: string; readerType: ReaderType },
    signal?: AbortSignal,
  ): Promise<TtsPlaybackPlan | null> => {
    while (!signal?.aborted) {
      const resolution = await resolveTtsPlaybackPlan(planUrl, signal);
      if (resolution.status === 'ready') {
        return assertAuthoritativePlaybackPlan(resolution.plan, expected);
      }
      setPlanLifecycle({ status: resolution.status, error: null });
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, resolution.retryAfterMs);
        signal?.addEventListener('abort', () => {
          window.clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    return null;
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

  const ensurePlaybackPlan = useCallback(async (
    planRequest: TtsPlaybackPlanRequest,
    signal?: AbortSignal,
  ): Promise<TtsPlaybackPlan | null> => {
    const existing = playbackPlanRef.current;
    if (existing?.planObjectKey && preparedRequestKeyRef.current === requestKeyRef.current) {
      if (existing.planId && !playbackSeekLayout) {
        const layout = await fetchPlaybackSeekLayoutUntilReady(
          `/api/tts/playback/plans/${encodeURIComponent(existing.planId)}/seek-layout`,
          signal,
        );
        if (!signal?.aborted && layout) setPlaybackSeekLayout(layout);
      }
      return existing;
    }

    setPlanLifecycle({ status: 'queued', error: null });
    const planHandle = await createTtsPlaybackPlan(planRequest.payload, planRequest.headers, signal);
    const plan = await fetchPlaybackPlanUntilReady(planHandle.planUrl, {
      documentId: planRequest.payload.documentId,
      readerType: activeReaderType,
    }, signal);
    if (!plan) return null;
    if (plan.segments.length > 0) {
      const layout = await fetchPlaybackSeekLayoutUntilReady(planHandle.seekLayoutUrl, signal);
      if (!signal?.aborted && layout) setPlaybackSeekLayout(layout);
    }
    return plan;
  }, [
    activeReaderType,
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
    const operationKey = JSON.stringify(planRequest);
    lifecycleRequestKeyRef.current = operationKey;
    const plan = await ensurePlaybackPlan(planRequest, signal);
    if (!plan || signal?.aborted || requestKeyRef.current !== operationKey) return null;
    const applied = applyPlaybackPlan(plan);
    preparedRequestKeyRef.current = operationKey;
    setPlanLifecycle({ status: 'ready', error: null });
    return applied;
  }, [applyPlaybackPlan, ensurePlaybackPlan]);

  const acceptBootstrapPlaybackPlan = useCallback(async (
    value: TtsPlaybackPlan,
  ): Promise<TtsPlaybackPlan> => {
    const plan = assertAuthoritativePlaybackPlan(value, {
      documentId: request?.payload.documentId ?? value.documentId,
      readerType: activeReaderType,
    });
    const key = requestKeyRef.current;
    lifecycleRequestKeyRef.current = key;
    const applied = applyPlaybackPlan(plan);
    preparedRequestKeyRef.current = key;
    setPlanLifecycle({ status: 'ready', error: null });
    if (plan.planId && plan.segments.length > 0) {
      void fetchPlaybackSeekLayoutUntilReady(
        `/api/tts/playback/plans/${encodeURIComponent(plan.planId)}/seek-layout`,
      ).then((layout) => {
        if (layout && requestKeyRef.current === key) setPlaybackSeekLayout(layout);
      });
    }
    return applied;
  }, [
    activeReaderType,
    applyPlaybackPlan,
    fetchPlaybackSeekLayoutUntilReady,
    request,
    setPlaybackSeekLayout,
  ]);

  const invalidatePlaybackPlanLifecycle = useCallback(() => {
    preparedRequestKeyRef.current = '';
    lifecycleRequestKeyRef.current = '';
    setPlanLifecycle(IDLE_PLAN_LIFECYCLE);
  }, []);

  return {
    acceptBootstrapPlaybackPlan,
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
    ensurePlaybackPlan,
    invalidatePlaybackPlanLifecycle,
    planLifecycle,
  };
}
