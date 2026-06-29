'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import {
  normalizePlaybackPlan,
  playbackPlanToCanonicalSegments,
  type TtsPlaybackPlan,
} from '@/lib/client/tts/playback-plan';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

type PlaybackPlanSource = 'idle' | 'worker';

type PlaybackModelState = {
  plan: TtsPlaybackPlan | null;
  planSource: PlaybackPlanSource;
  segments: CanonicalTtsSegment[];
  seekLayout: TtsPlaybackSeekLayout | null;
  selectedOrdinal: number | null;
};

export type PlaybackPlanResetOptions = {
  resetSelection?: boolean;
  resetSeekLayout?: boolean;
};

const EMPTY_MODEL: PlaybackModelState = {
  plan: null,
  planSource: 'idle',
  segments: [],
  seekLayout: null,
  selectedOrdinal: null,
};

function normalizeOrdinal(value: number): number {
  return Math.max(0, Math.floor(value));
}

export function useTtsPlaybackModel() {
  const [model, setModel] = useState<PlaybackModelState>(EMPTY_MODEL);
  const playbackPlanRef = useRef<ReturnType<typeof normalizePlaybackPlan> | null>(null);
  const playbackSegmentsRef = useRef<CanonicalTtsSegment[]>([]);
  const selectedOrdinalRef = useRef<number | null>(null);

  const sentences = useMemo(
    () => model.segments.map((segment) => segment.text),
    [model.segments],
  );
  const currentIndex = useMemo(() => {
    if (model.selectedOrdinal === null) return 0;
    const index = model.segments.findIndex((segment) => segment.ordinal === model.selectedOrdinal);
    return index >= 0 ? index : 0;
  }, [model.segments, model.selectedOrdinal]);
  const currentSegment = model.segments[currentIndex] ?? null;
  const currentSentence = currentSegment?.text ?? '';
  const selectedOrdinal = model.selectedOrdinal;

  const setSelectedOrdinal = useCallback((ordinal: number | null) => {
    const normalized = ordinal === null ? null : normalizeOrdinal(ordinal);
    selectedOrdinalRef.current = normalized;
    setModel((previous) => (
      previous.selectedOrdinal === normalized
        ? previous
        : { ...previous, selectedOrdinal: normalized }
    ));
  }, []);

  const applyWorkerPlan = useCallback((plan: ReturnType<typeof normalizePlaybackPlan>) => {
    const canonicalPlan = playbackPlanToCanonicalSegments(plan);
    playbackPlanRef.current = plan;
    playbackSegmentsRef.current = canonicalPlan;
    setModel((previous) => ({
      ...previous,
      plan,
      planSource: 'worker',
      segments: canonicalPlan,
    }));
    return canonicalPlan;
  }, []);

  const setPlaybackSeekLayout = useCallback((seekLayout: TtsPlaybackSeekLayout | null) => {
    setModel((previous) => (
      previous.seekLayout === seekLayout
        ? previous
        : { ...previous, seekLayout }
    ));
  }, []);

  const resetPlaybackPlan = useCallback((options?: PlaybackPlanResetOptions) => {
    const resetSelection = options?.resetSelection ?? true;
    const resetSeekLayout = options?.resetSeekLayout ?? true;
    playbackPlanRef.current = null;
    playbackSegmentsRef.current = [];
    if (resetSelection) {
      selectedOrdinalRef.current = null;
    }
    setModel((previous) => ({
      ...previous,
      plan: null,
      planSource: 'idle',
      segments: [],
      seekLayout: resetSeekLayout ? null : previous.seekLayout,
      selectedOrdinal: resetSelection ? null : previous.selectedOrdinal,
    }));
  }, []);

  const clearPlaybackSegments = useCallback((options?: { resetSelection?: boolean }) => {
    const resetSelection = options?.resetSelection ?? true;
    playbackSegmentsRef.current = [];
    if (resetSelection) {
      selectedOrdinalRef.current = null;
    }
    setModel((previous) => ({
      ...previous,
      segments: [],
      planSource: 'idle',
      selectedOrdinal: resetSelection ? null : previous.selectedOrdinal,
    }));
  }, []);

  return {
    playbackPlanRef,
    playbackSegmentsRef,
    selectedOrdinalRef,
    playbackPlan: model.plan,
    playbackPlanSource: model.planSource,
    playbackSegments: model.segments,
    sentences,
    currentIndex,
    currentSentence,
    currentSegment,
    selectedOrdinal,
    playbackSeekLayout: model.seekLayout,
    applyWorkerPlan,
    clearPlaybackSegments,
    resetPlaybackPlan,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
  };
}
