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
  const inFlightRef = useRef<{ key: string; promise: Promise<TtsPlaybackPlan | null>; controller: AbortController } | null>(null);

  useEffect(() => {
    const preparedKey = preparedRequestKeyRef.current;
    const inFlight = inFlightRef.current;
    const inFlightChanged = Boolean(inFlight && inFlight.key !== requestKey);
    const preparedChanged = Boolean(preparedKey && preparedKey !== requestKey);
    const lifecycleChanged = Boolean(
      lifecycleRequestKeyRef.current
      && lifecycleRequestKeyRef.current !== requestKey,
    );
    if (!inFlightChanged && !preparedChanged && !lifecycleChanged) return;
    if (inFlightChanged) inFlight?.controller.abort();
    if (inFlightChanged) inFlightRef.current = null;
    preparedRequestKeyRef.current = '';
    lifecycleRequestKeyRef.current = '';
    resetPlaybackPlan({ resetSelection: false });
    setPlanLifecycle(IDLE_PLAN_LIFECYCLE);
  }, [requestKey, resetPlaybackPlan]);

  useEffect(() => () => {
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
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

  const preparePlaybackPlan = useCallback(async (): Promise<TtsPlaybackPlan | null> => {
    const planRequest = buildPlaybackPlanRequest();
    if (!planRequest) return null;
    const key = requestKeyRef.current;
    if (planLifecycle.status === 'ready' && preparedRequestKeyRef.current === key) {
      return playbackPlanRef.current;
    }
    const current = inFlightRef.current;
    if (current?.key === key) return current.promise;
    current?.controller.abort();
    const controller = new AbortController();
    lifecycleRequestKeyRef.current = key;
    const promise = (async () => {
      try {
        return await createAndApplyPlaybackPlan(planRequest, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isAbortLikeError(error)) return null;
        const resolved = error instanceof Error ? error : new Error('Failed to build reading plan');
        setPlanLifecycle({ status: 'failed', error: resolved });
        return null;
      } finally {
        if (inFlightRef.current?.controller === controller) inFlightRef.current = null;
      }
    })();
    inFlightRef.current = { key, promise, controller };
    return promise;
  }, [
    buildPlaybackPlanRequest,
    createAndApplyPlaybackPlan,
    planLifecycle.status,
    playbackPlanRef,
  ]);

  const retryPlaybackPlan = useCallback(async (): Promise<TtsPlaybackPlan | null> => {
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
    preparedRequestKeyRef.current = '';
    lifecycleRequestKeyRef.current = '';
    resetPlaybackPlan({ resetSelection: false });
    setPlanLifecycle(IDLE_PLAN_LIFECYCLE);
    return preparePlaybackPlan();
  }, [preparePlaybackPlan, resetPlaybackPlan]);

  const invalidatePlaybackPlanLifecycle = useCallback(() => {
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
    preparedRequestKeyRef.current = '';
    lifecycleRequestKeyRef.current = '';
    setPlanLifecycle(IDLE_PLAN_LIFECYCLE);
  }, []);

  return {
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
    ensurePlaybackPlan,
    invalidatePlaybackPlanLifecycle,
    planLifecycle,
    preparePlaybackPlan,
    retryPlaybackPlan,
  };
}
