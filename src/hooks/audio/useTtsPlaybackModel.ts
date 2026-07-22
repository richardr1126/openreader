'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import {
  normalizePlaybackPlan,
  playbackPlanToCanonicalSegments,
  type TtsPlaybackPlan,
} from '@/lib/client/tts/playback-plan';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

type PlaybackModelState = {
  plan: TtsPlaybackPlan | null;
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
    if (model.selectedOrdinal === null) return -1;
    const index = model.segments.findIndex((segment) => segment.ordinal === model.selectedOrdinal);
    return index;
  }, [model.segments, model.selectedOrdinal]);
  // A loaded plan is not a selection. Keeping segment zero "current" while
  // selectedOrdinal was null let every viewer run its initial highlight before
  // its rendered surface had committed a plan-backed location.
  const currentSegment = model.selectedOrdinal === null
    ? null
    : model.segments[currentIndex] ?? null;
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

  return {
    playbackPlanRef,
    playbackSegmentsRef,
    selectedOrdinalRef,
    playbackPlan: model.plan,
    playbackSegments: model.segments,
    sentences,
    currentIndex,
    currentSentence,
    currentSegment,
    selectedOrdinal,
    playbackSeekLayout: model.seekLayout,
    applyWorkerPlan,
    resetPlaybackPlan,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
  };
}
